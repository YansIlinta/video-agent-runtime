import { ProjectStore } from "../../core/src/index.js";
import { FFmpegRenderer, selfCheckPreview } from "../../render/src/index.js";
import { FFmpegVisualEvidenceProvider, probeMedia } from "../../media/src/index.js";
import { createNodeHostProfile } from "../../platform/src/index.js";
import { FakeASRProvider, FakeLLMProvider, FakeVoiceProvider, OpenAIASRProvider, OpenAILLMProvider, OpenAIVoiceProvider, type OpenAIASRModel } from "../../providers/src/index.js";
import { FasterWhisperASRProvider, KokoroTTSProvider, Qwen3ASRProvider, Qwen3VoiceProvider, WhisperXProvider } from "../../speech/src/index.js";
import { VideoAgentCore } from "./video-agent-core.js";
import { loadRuntimeConfig, loadRuntimeSecrets, type RuntimeConfig } from "./config.js";
import { StructuredLogger } from "./logger.js";

function createOpenAIASR(model: string, apiKey?: string) {
  if (model !== "gpt-4o-transcribe-diarize" && model !== "whisper-1") throw new Error(`Unsupported edit-safe OpenAI ASR model ${model}; use gpt-4o-transcribe-diarize for speaker segments or whisper-1 for word timestamps`);
  return new OpenAIASRProvider(model as OpenAIASRModel, apiKey);
}

export function createRuntime(options: { workspaceRoot?: string; asrProvider?: "fake" | "faster-whisper" | "qwen3-asr" | "openai"; ttsProvider?: "fake" | "kokoro" | "qwen3-tts" | "openai"; plannerProvider?: "fake" | "openai"; config?: RuntimeConfig } = {}): VideoAgentCore {
  const loaded = options.config ?? loadRuntimeConfig();
  const secrets = loadRuntimeSecrets();
  const config: RuntimeConfig = { ...loaded, ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}), providers: { ...loaded.providers, ...(options.asrProvider ? { asr: options.asrProvider } : {}), ...(options.ttsProvider ? { tts: options.ttsProvider } : {}), ...(options.plannerProvider ? { planner: options.plannerProvider } : {}) } };
  const asr = config.providers.asr === "faster-whisper"
    ? new FasterWhisperASRProvider(config.providers.asrModel, config.executables.python)
    : config.providers.asr === "qwen3-asr"
      ? new Qwen3ASRProvider(config.providers.asrModel, "Qwen/Qwen3-ForcedAligner-0.6B", config.executables.python)
      : config.providers.asr === "openai"
        ? createOpenAIASR(config.providers.asrModel, secrets.openaiApiKey)
        : new FakeASRProvider();

  const voice = config.providers.tts === "fake"
    ? new FakeVoiceProvider()
    : config.providers.tts === "openai"
      ? new OpenAIVoiceProvider(config.providers.ttsModel, secrets.openaiApiKey)
      : config.providers.tts === "qwen3-tts"
        ? new Qwen3VoiceProvider(config.providers.ttsModel, "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", config.executables.python)
        : undefined;
  const tts = config.providers.tts === "kokoro" ? new KokoroTTSProvider(config.providers.ttsModel, config.executables.python) : voice!;
  const planner = config.providers.planner === "openai" ? new OpenAILLMProvider(config.providers.plannerModel, secrets.openaiApiKey) : new FakeLLMProvider();
  const whisperx = config.providers.alignment === "whisperx" || config.providers.diarization === "whisperx" ? new WhisperXProvider("default", config.executables.python, secrets.huggingFaceToken) : undefined;
  const host = createNodeHostProfile(config.workspaceRoot);
  return new VideoAgentCore(new ProjectStore(config.workspaceRoot), { asr, tts, ...(voice ? { voice } : {}), planner, renderer: new FFmpegRenderer(config.executables.ffmpeg), previewSelfCheck: selfCheckPreview, mediaProbe: { probe: (uri) => probeMedia(uri, config.executables.ffprobe) }, visual: new FFmpegVisualEvidenceProvider(config.executables.ffmpeg), ...(config.providers.alignment === "whisperx" && whisperx ? { alignment: whisperx } : {}), ...(config.providers.diarization === "whisperx" && whisperx ? { diarization: whisperx } : {}) }, { ...config.limits, jobMaxAttempts: config.jobs.maxAttempts, baseRetryMs: config.jobs.baseRetryMs }, new StructuredLogger(config.logging.level), host.primitives, host.background);
}
