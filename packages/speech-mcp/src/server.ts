#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenAILLMProvider } from "../../providers/src/openai.js";
import { OpenAIVoiceProvider } from "../../providers/src/openai-voice.js";
import type { ASRProvider, ASRResult, TTSProvider } from "../../providers/src/contracts.js";
import { FasterWhisperASRProvider } from "../../speech/src/asr.js";
import { KokoroTTSProvider } from "../../speech/src/tts.js";
import { Qwen3ASRProvider, Qwen3TTSProvider } from "../../speech/src/qwen3.js";
import { ChatCompletionsStructuredGenerator, type ChatProviderKind } from "../../speech/src/chat-structured.js";
import {
  extractSpeechAudio,
  muxTranslatedAudio,
  speechTranslationSchema,
  synthesizeTranslation,
  transcribeSpeech,
  translateAsrResult,
  type SpeechTranslation,
  type StructuredTextGenerator,
} from "../../speech/src/speech-pipeline.js";
import type { ReasoningLevel } from "../../core/src/schemas.js";

const workspaceRoot = path.resolve(process.env.VIDEO_AGENT_SPEECH_WORKSPACE ?? path.join(process.cwd(), "speech-runs"));
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const python = process.env.VIDEO_AGENT_PYTHON ?? "python";

const server = new McpServer({ name: "video-agent-speech", version: "0.1.0" });
const outputSchema = z.object({ result: z.unknown() });

function register<T extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: z.ZodObject<T>,
  handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
) {
  server.registerTool(name, { description, inputSchema, outputSchema }, async (input) => {
    try {
      const result = await handler(input as z.infer<z.ZodObject<T>>);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: message }], structuredContent: { result: { error: message } }, isError: true };
    }
  });
}

interface SpeechRun {
  id: string;
  sourcePath: string;
  audioPath: string;
  asrProvider: string;
  asrModel: string;
  asr: ASRResult;
  translation?: SpeechTranslation;
  createdAt: string;
}

async function runDirectory(runId: string) {
  const safe = path.basename(runId);
  if (safe !== runId || !/^[a-zA-Z0-9-]+$/u.test(runId)) throw new Error("Invalid run id");
  const directory = path.join(workspaceRoot, safe);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function saveRun(run: SpeechRun) {
  const directory = await runDirectory(run.id);
  await writeFile(path.join(directory, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
}

async function loadRun(runId: string): Promise<SpeechRun> {
  const directory = await runDirectory(runId);
  return JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")) as SpeechRun;
}

function makeAsr(provider: "faster-whisper" | "qwen3-asr", model?: string): ASRProvider {
  if (provider === "qwen3-asr") return new Qwen3ASRProvider(model ?? "Qwen/Qwen3-ASR-0.6B", python);
  return new FasterWhisperASRProvider(model ?? "small", python);
}

function makeTts(provider: "kokoro" | "qwen3-tts" | "openai", model?: string): TTSProvider {
  if (provider === "qwen3-tts") return new Qwen3TTSProvider(model ?? "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", python);
  if (provider === "openai") return new OpenAIVoiceProvider(model ?? "gpt-4o-mini-tts", process.env.OPENAI_API_KEY);
  return new KokoroTTSProvider(model ?? "hexgrad/Kokoro-82M", python);
}

function defaultLlmBaseUrl(kind: ChatProviderKind) {
  if (kind === "deepseek") return "https://api.deepseek.com";
  if (kind === "openrouter") return "https://openrouter.ai/api/v1";
  return "https://api.openai.com/v1";
}

function llmCredential(kind: ChatProviderKind) {
  if (process.env.VIDEO_AGENT_LLM_API_KEY) return process.env.VIDEO_AGENT_LLM_API_KEY;
  if (kind === "deepseek") return process.env.DEEPSEEK_API_KEY;
  if (kind === "openrouter") return process.env.OPENROUTER_API_KEY;
  return process.env.OPENAI_API_KEY;
}

function makeLlm(options: {
  model: string;
  reasoning: ReasoningLevel;
  providerKind: ChatProviderKind;
  transport: "responses" | "chat-completions";
  baseUrl?: string;
}): StructuredTextGenerator {
  const baseUrl = options.baseUrl ?? process.env.VIDEO_AGENT_LLM_BASE_URL ?? defaultLlmBaseUrl(options.providerKind);
  const credential = llmCredential(options.providerKind);
  if (options.transport === "chat-completions") {
    return new ChatCompletionsStructuredGenerator(options.model, credential, baseUrl, options.providerKind, options.reasoning);
  }
  if (options.providerKind !== "openai" && options.providerKind !== "openai-compatible" && options.providerKind !== "custom") {
    throw new Error(`Responses transport is not enabled for ${options.providerKind}; use chat-completions`);
  }
  const provider = new OpenAILLMProvider(options.model, credential, baseUrl, 120_000, undefined, undefined, options.reasoning);
  return provider as unknown as StructuredTextGenerator;
}

const asrProviderSchema = z.enum(["faster-whisper", "qwen3-asr"]);
const ttsProviderSchema = z.enum(["kokoro", "qwen3-tts", "openai"]);
const reasoningSchema = z.enum(["off", "low", "medium", "high", "extra-high"]);
const llmProviderSchema = z.enum(["openai", "deepseek", "openrouter", "openai-compatible", "custom"]);
const llmTransportSchema = z.enum(["responses", "chat-completions"]);

register("speech_models", "List the speech-only MCP model families. Model IDs remain overridable per call; this is a catalog, not a hardcoded allow-list.", z.object({}), async () => ({
  asr: [
    { provider: "faster-whisper", models: ["tiny", "base", "small", "medium", "large-v3", "turbo"], note: "lightweight local baseline" },
    { provider: "qwen3-asr", models: ["Qwen/Qwen3-ASR-0.6B", "Qwen/Qwen3-ASR-1.7B"], aligner: "Qwen/Qwen3-ForcedAligner-0.6B", note: "optional frontier local model" },
  ],
  llm: {
    providers: ["openai", "deepseek", "openrouter", "openai-compatible", "custom"],
    transports: ["responses", "chat-completions"],
    model: "arbitrary string per call",
    reasoning: reasoningSchema.options,
    credential: "provider env var or VIDEO_AGENT_LLM_API_KEY; never passed as MCP input",
    notes: [
      "OpenAI defaults to Responses transport.",
      "DeepSeek/OpenRouter/custom OpenAI-compatible endpoints use chat-completions.",
      "DeepSeek reasoning is selected primarily by model (for example a reasoner model); no unsupported generic effort field is forced.",
    ],
  },
  tts: [
    { provider: "kokoro", models: ["hexgrad/Kokoro-82M"], note: "lightweight local baseline" },
    { provider: "qwen3-tts", models: ["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"], note: "optional multilingual/custom-voice model" },
    { provider: "openai", models: ["gpt-4o-mini-tts"], note: "hosted" },
  ],
}));

register("speech_provider_health", "Check only the selected ASR/TTS runtimes without loading the full video editing runtime.", z.object({
  asrProvider: asrProviderSchema.optional(),
  asrModel: z.string().optional(),
  ttsProvider: ttsProviderSchema.optional(),
  ttsModel: z.string().optional(),
}), async ({ asrProvider, asrModel, ttsProvider, ttsModel }) => {
  const asr = makeAsr(asrProvider ?? "faster-whisper", asrModel);
  const tts = makeTts(ttsProvider ?? "kokoro", ttsModel);
  return {
    asr: await asr.health?.(),
    tts: await tts.health?.(),
    llmCredentials: {
      openai: Boolean(process.env.OPENAI_API_KEY ?? process.env.VIDEO_AGENT_LLM_API_KEY),
      deepseek: Boolean(process.env.DEEPSEEK_API_KEY ?? process.env.VIDEO_AGENT_LLM_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY ?? process.env.VIDEO_AGENT_LLM_API_KEY),
    },
    ffmpeg,
  };
});

register("speech_transcribe", "Extract audio from a local video/audio file and run the selected ASR model. No Project/Timeline/EditPlan is created.", z.object({
  sourcePath: z.string().min(1),
  provider: asrProviderSchema.default("faster-whisper"),
  model: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().optional(),
}), async ({ sourcePath, provider, model, language, prompt }) => {
  const runId = randomUUID();
  const directory = await runDirectory(runId);
  const audioPath = path.join(directory, "source-16k.wav");
  await extractSpeechAudio(sourcePath, audioPath, { ffmpeg });
  const asr = makeAsr(provider, model);
  const result = await transcribeSpeech(asr, audioPath, { ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) });
  const run: SpeechRun = { id: runId, sourcePath: path.resolve(sourcePath), audioPath, asrProvider: asr.id, asrModel: asr.model, asr: result, createdAt: new Date().toISOString() };
  await saveRun(run);
  return { runId, provider: asr.id, model: asr.model, language: result.language, segments: result.segments, warnings: result.warnings };
});

register("speech_translate", "Translate an ASR run segment-by-segment with a selectable LLM provider/model/reasoning level while preserving segment identity/order.", z.object({
  runId: z.string().min(1),
  targetLanguage: z.string().min(1),
  providerKind: llmProviderSchema.default("openai"),
  transport: llmTransportSchema.default("responses"),
  model: z.string().min(1),
  reasoning: reasoningSchema.default("medium"),
  baseUrl: z.string().url().optional(),
  prompt: z.string().optional(),
}), async ({ runId, targetLanguage, providerKind, transport, model, reasoning, baseUrl, prompt }) => {
  const run = await loadRun(runId);
  const translation = await translateAsrResult(run.asr, makeLlm({ model, reasoning, providerKind, transport, ...(baseUrl ? { baseUrl } : {}) }), { targetLanguage, ...(prompt ? { prompt } : {}) });
  run.translation = translation;
  await saveRun(run);
  return { runId, providerKind, transport, model, reasoning, translation };
});

register("speech_synthesize", "Synthesize the translated segments into a dubbed WAV track using the selected TTS model and voice.", z.object({
  runId: z.string().min(1),
  provider: ttsProviderSchema.default("kokoro"),
  model: z.string().optional(),
  voiceId: z.string().min(1),
  speed: z.number().min(0.5).max(1.5).optional(),
}), async ({ runId, provider, model, voiceId, speed }) => {
  const run = await loadRun(runId);
  if (!run.translation) throw new Error("Run has not been translated yet");
  const outputDirectory = path.join(await runDirectory(runId), "tts");
  return synthesizeTranslation(run.asr, speechTranslationSchema.parse(run.translation), makeTts(provider, model), {
    outputDirectory,
    voiceId,
    ffmpeg,
    ...(speed === undefined ? {} : { speed }),
  });
});

register("video_translate", "End-to-end language replacement proof: video/audio -> ASR -> LLM translation -> TTS -> new video with the translated audio track. This is narration-style dubbing, not lip-sync editing.", z.object({
  sourcePath: z.string().min(1),
  targetLanguage: z.string().min(1),
  asrProvider: asrProviderSchema.default("faster-whisper"),
  asrModel: z.string().optional(),
  asrLanguage: z.string().optional(),
  llmProviderKind: llmProviderSchema.default("openai"),
  llmTransport: llmTransportSchema.default("responses"),
  llmModel: z.string().min(1),
  reasoning: reasoningSchema.default("medium"),
  llmBaseUrl: z.string().url().optional(),
  prompt: z.string().optional(),
  ttsProvider: ttsProviderSchema.default("kokoro"),
  ttsModel: z.string().optional(),
  voiceId: z.string().min(1),
}), async ({ sourcePath, targetLanguage, asrProvider, asrModel, asrLanguage, llmProviderKind, llmTransport, llmModel, reasoning, llmBaseUrl, prompt, ttsProvider, ttsModel, voiceId }) => {
  const runId = randomUUID();
  const directory = await runDirectory(runId);
  const audioPath = path.join(directory, "source-16k.wav");
  await extractSpeechAudio(sourcePath, audioPath, { ffmpeg });
  const asr = makeAsr(asrProvider, asrModel);
  const result = await transcribeSpeech(asr, audioPath, { ...(asrLanguage ? { language: asrLanguage } : {}) });
  const translation = await translateAsrResult(result, makeLlm({ model: llmModel, reasoning, providerKind: llmProviderKind, transport: llmTransport, ...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}) }), { targetLanguage, ...(prompt ? { prompt } : {}) });
  const run: SpeechRun = { id: runId, sourcePath: path.resolve(sourcePath), audioPath, asrProvider: asr.id, asrModel: asr.model, asr: result, translation, createdAt: new Date().toISOString() };
  await saveRun(run);
  const manifest = await synthesizeTranslation(result, translation, makeTts(ttsProvider, ttsModel), { outputDirectory: path.join(directory, "tts"), voiceId, ffmpeg });
  const outputVideoPath = path.join(directory, "translated.mp4");
  const dubbed = await muxTranslatedAudio(sourcePath, manifest, outputVideoPath, { ffmpeg });
  return {
    runId,
    outputVideoPath: dubbed.outputVideoPath,
    dubbedAudioPath: dubbed.dubbedAudioPath,
    sourceLanguage: result.language,
    targetLanguage,
    asr: { provider: asr.id, model: asr.model },
    llm: { providerKind: llmProviderKind, transport: llmTransport, model: llmModel, reasoning, baseUrl: llmBaseUrl ?? process.env.VIDEO_AGENT_LLM_BASE_URL ?? defaultLlmBaseUrl(llmProviderKind) },
    tts: { provider: dubbed.provider, model: dubbed.model, voiceId },
    segmentCount: dubbed.segments.length,
    warnings: [
      ...result.warnings,
      "Translated audio is narration-style sequential dubbing; timing/lip-sync editing is intentionally deferred.",
    ],
  };
});

await mkdir(workspaceRoot, { recursive: true });
await server.connect(new StdioServerTransport());
