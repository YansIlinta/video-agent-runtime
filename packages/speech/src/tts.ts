import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectRepository, SpeechAsset, VoiceProfile } from "../../core/src/index.js";
import { secondsToUs } from "../../core/src/index.js";
import { assertVoiceAuthorized, voiceGenerationCacheKey } from "./voice.js";
import type { OperationContext, TTSProvider, TTSResult } from "../../providers/src/index.js";
import { runProcess } from "../../media/src/index.js";

const KOKORO_LICENSE = { code: "Apache-2.0", weights: "Apache-2.0", voice: "Apache-2.0 canonical voice pack", commercialUse: true, sourceUrl: "https://huggingface.co/hexgrad/Kokoro-82M" } as const;

export class KokoroTTSProvider implements TTSProvider {
  readonly id = "kokoro";
  constructor(readonly model = "hexgrad/Kokoro-82M", private readonly python = process.env.VIDEO_AGENT_PYTHON ?? "python", private readonly timeoutMs = 20 * 60_000) {}

  capabilities() {
    return { streaming: false, voiceSelection: true, voiceCloning: false, styleControl: false, speedControl: true, multilingual: true, timestamps: true, phonemeAlignment: true };
  }

  async listVoices(): Promise<VoiceProfile[]> {
    return [
      ["af_heart", "American English — Heart", ["en-us"]],
      ["am_adam", "American English — Adam", ["en-us"]],
      ["bf_emma", "British English — Emma", ["en-gb"]],
      ["zf_xiaobei", "Mandarin Chinese — Xiaobei", ["zh"]],
    ].map(([id, name, languages]) => ({ id: id as string, type: "preset" as const, provider: this.id, providerVoiceId: id as string, name: name as string, model: this.model, languages: languages as string[], cloning: false, status: "active" as const, referenceAssetIds: [], authorizationStatus: "not_required" as const, createdAt: new Date(0).toISOString(), providerMetadata: {}, usageRestrictions: ["Verify the installed voice artifact manifest before distribution"], license: KOKORO_LICENSE }));
  }

  async synthesize(input: { text: string; voiceId: string; language: string; speed?: number }, context?: OperationContext): Promise<TTSResult> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "video-agent-kokoro-"));
    const outputPath = path.join(tempRoot, "speech.wav");
    try {
      const script = path.resolve(import.meta.dirname, "../python/kokoro_sidecar.py");
      context?.onProgress?.(0.05, "tts-loading", `Loading ${this.model}`);
      const result = await runProcess(this.python, [script, "--text", input.text, "--voice", input.voiceId, "--language", input.language, "--speed", String(input.speed ?? 1), "--model", this.model, "--output", outputPath], { timeoutMs: this.timeoutMs, maxOutputBytes: 5 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
      if (result.exitCode !== 0) throw new Error(`Kokoro sidecar failed: ${result.stderr.slice(-4000)}`);
      const metadata = JSON.parse(result.stdout) as { durationSeconds: number; sampleRate: number; wordTimings: Array<{ text: string; startSeconds: number; endSeconds: number }> };
      context?.onProgress?.(0.95, "tts-finalizing", "Measuring generated speech");
      return { audio: await readFile(outputPath), format: "wav", durationSeconds: metadata.durationSeconds, sampleRate: metadata.sampleRate, wordTimings: metadata.wordTimings, model: this.model, voiceId: input.voiceId, license: KOKORO_LICENSE };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async health() { try { const result = await runProcess(this.python, ["-c", "import kokoro; print('ready')"], { timeoutMs: 10_000, maxOutputBytes: 100_000 }); return { id: this.id, status: result.exitCode === 0 ? "ready" as const : "unavailable" as const, message: result.exitCode === 0 ? `${this.model} runtime installed` : result.stderr.slice(-500), capabilities: this.capabilities() }; } catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error), capabilities: this.capabilities() }; } }
}

export function ttsCacheKey(provider: TTSProvider, input: { text: string; voiceId: string; language: string; speed?: number }): string {
  return createHash("sha256").update(JSON.stringify({ provider: provider.id, model: provider.model, ...input })).digest("hex");
}

export async function synthesizeSpeech(store: ProjectRepository, projectId: string, provider: TTSProvider, input: { text: string; voiceId: string; language: string; speed?: number; voiceProfile?: VoiceProfile; speechType?: SpeechAsset["type"]; sourceTextVersion?: number; sourceSegmentIds?: string[]; style?: Record<string, unknown> }, context?: OperationContext): Promise<SpeechAsset> {
  if (input.voiceProfile) assertVoiceAuthorized(input.voiceProfile);
  const cacheKey = input.voiceProfile ? voiceGenerationCacheKey({ text: input.text, profile: input.voiceProfile, provider: provider.id, model: provider.model, language: input.language, ...(input.speed ? { speed: input.speed } : {}), ...(input.style ? { style: input.style } : {}) }) : ttsCacheKey(provider, input);
  const cached = await store.findSpeechAssetByCacheKey(projectId, cacheKey);
  if (cached) { context?.onProgress?.(1, "cache-hit", "Reused cached speech"); return cached; }
  const result = await provider.synthesize(input, context);
  const fallbackTokens = input.text.match(/[\p{Script=Han}]|[^\s\p{Script=Han}]+/gu) ?? [input.text];
  const timingWords = result.wordTimings.length ? result.wordTimings : fallbackTokens.map((text, index) => ({ text, startSeconds: (result.durationSeconds * index) / fallbackTokens.length, endSeconds: (result.durationSeconds * (index + 1)) / fallbackTokens.length }));
  const id = randomUUID();
  const relativePath = `derived/${id}.wav`;
  await writeFile(store.resolveProjectFile(projectId, relativePath), result.audio, { flag: "wx" });
  const assetId = `audio-${id}`;
  const speechAsset: SpeechAsset = {
    id,
    assetId,
    type: input.speechType ?? (input.voiceProfile?.type === "cloned" ? "cloned_voice" : input.voiceProfile?.type === "designed" ? "designed_voice" : "tts"),
    generated: true,
    text: input.text,
    provider: provider.id,
    model: result.model,
    voiceId: input.voiceId,
    ...(input.voiceProfile ? { voiceProfileId: input.voiceProfile.id } : {}),
    language: input.language,
    durationUs: secondsToUs(result.durationSeconds),
    sampleRate: result.sampleRate,
    generationParameters: { speed: input.speed ?? 1, style: input.style ?? {} },
    ...(result.license ? { license: result.license } : {}),
    wordTimings: timingWords.map((word) => ({ id: randomUUID(), rawText: word.text, normalizedText: word.text.normalize("NFKC"), displayText: word.text.normalize("NFKC"), startUs: secondsToUs(word.startSeconds), endUs: secondsToUs(word.endSeconds), timingSource: result.wordTimings.length ? "aligned" as const : "estimated" as const })),
    sourceText: input.text,
    sourceTextVersion: input.sourceTextVersion ?? 1,
    projectId,
    sourceSegmentIds: input.sourceSegmentIds ?? [],
    cacheKey,
    createdAt: new Date().toISOString(),
  };
  await store.writeSpeechAsset(projectId, speechAsset);
  return speechAsset;
}
