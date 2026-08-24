import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VoiceDesignRequest, VoiceProfile } from "../../core/src/schemas.js";
import type { OperationContext, TTSFileResult, TTSInput, TTSResult, VoiceEnrollmentInput, VoiceProvider } from "../../providers/src/contracts.js";
import { runProcess } from "../../media/src/index.js";

const QWEN3_TTS_LICENSE = { code: "Apache-2.0", weights: "Apache-2.0", voice: "User-authorized reference or synthetic designed voice", commercialUse: true, sourceUrl: "https://github.com/QwenLM/Qwen3-TTS" } as const;
const DEFAULT_BASE_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
const DEFAULT_DESIGN_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";
const MAX_TEXT_CHARS = 4_096;
const CLONE_REFERENCE_POLICY = { minDurationSeconds: 3, maxDurationSeconds: 15, highQualityRequiresReferenceText: true, embeddingOnlySupported: true } as const;

interface StoredVoiceManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  referenceAudio: string;
  referenceText?: string;
  referenceAssetId?: string;
  languages: string[];
  createdAt: string;
  origin: "authorized-clone" | "voice-design";
  xVectorOnly: boolean;
  referenceRangeSeconds?: { start: number; end: number };
}

function qwenLanguage(value: string) {
  const map: Record<string, string> = { zh: "Chinese", "zh-cn": "Chinese", en: "English", ja: "Japanese", ko: "Korean", de: "German", fr: "French", ru: "Russian", pt: "Portuguese", es: "Spanish", it: "Italian" };
  return map[value.toLowerCase()] ?? value;
}
function cancelled(signal?: AbortSignal) { return signal?.reason instanceof Error ? signal.reason : new Error("Qwen3-TTS cancelled"); }
function safeVoiceId(value: string) { if (!/^qwen3-[a-f0-9-]{16,}$/u.test(value)) throw new Error("Unknown Qwen3 voice id"); return value; }

export class Qwen3VoiceProvider implements VoiceProvider {
  readonly id = "qwen3-tts";
  private readonly voiceRoot: string;
  constructor(
    readonly model = DEFAULT_BASE_MODEL,
    private readonly designModel = DEFAULT_DESIGN_MODEL,
    private readonly python = process.env.VIDEO_AGENT_PYTHON ?? "python",
    voiceRoot = process.env.VIDEO_AGENT_QWEN3_TTS_VOICES ?? path.join(os.homedir(), ".video-agent", "qwen3-tts", "voices"),
    private readonly timeoutMs = 30 * 60_000,
    private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg",
  ) { this.voiceRoot = voiceRoot; }

  capabilities() { return { streaming: false, voiceSelection: true, voiceCloning: true, styleControl: false, speedControl: false, multilingual: true, timestamps: false, phonemeAlignment: false }; }
  voiceCapabilities() {
    return {
      tts: true,
      presetVoices: false,
      voiceDesign: true,
      zeroShotClone: true,
      persistentVoiceProfile: true,
      crossLingualClone: true,
      voiceConversion: false,
      streaming: false,
      wordTimestamps: false,
      // VoiceDesign accepts rich instructions, but the current clone-synthesis adapter has no
      // per-generation emotion/style parameter. Do not advertise capabilities the adapter cannot execute.
      emotionControl: false,
      styleControl: false,
      remoteDeletion: false,
    };
  }
  cloneReferencePolicy() { return { ...CLONE_REFERENCE_POLICY }; }
  async listVoices(): Promise<VoiceProfile[]> { return []; }

  private async ensureRoot() { await mkdir(this.voiceRoot, { recursive: true }); }
  private dir(voiceId: string) { return path.join(this.voiceRoot, safeVoiceId(voiceId)); }
  private manifestPath(voiceId: string) { return path.join(this.dir(voiceId), "voice.json"); }
  private async readManifest(voiceId: string): Promise<StoredVoiceManifest> { return JSON.parse(await readFile(this.manifestPath(voiceId), "utf8")) as StoredVoiceManifest; }
  private script() { return path.resolve(import.meta.dirname, "../python/qwen3_tts_sidecar.py"); }
  private validateText(text: string) { const trimmed = text.trim(); if (!trimmed) throw new Error("Qwen3-TTS text is required"); if (trimmed.length > MAX_TEXT_CHARS) throw new Error(`Qwen3-TTS text exceeds ${MAX_TEXT_CHARS} characters; split narration into timeline-sized chunks`); return trimmed; }

  private async extractReference(input: VoiceEnrollmentInput, output: string, context?: OperationContext) {
    if (context?.signal?.aborted) throw cancelled(context.signal);
    const range = input.referenceRangeSeconds;
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    if (range) args.push("-ss", String(Math.max(0, range.start)));
    args.push("-i", input.referencePath);
    if (range) args.push("-t", String(Math.max(0.1, Math.min(CLONE_REFERENCE_POLICY.maxDurationSeconds, range.end - range.start)))); else args.push("-t", String(CLONE_REFERENCE_POLICY.maxDurationSeconds));
    args.push("-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", output);
    context?.onProgress?.(0.05, "voice-reference", "Extracting a bounded mono voice reference");
    const result = await runProcess(this.ffmpeg, args, { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
    if (result.exitCode !== 0) throw new Error(`Unable to extract Qwen3 voice reference: ${result.stderr.slice(-2_000)}`);
    if ((await stat(output)).size < 1_024) throw new Error("Extracted Qwen3 voice reference is empty");
  }

  async enrollVoice(input: VoiceEnrollmentInput, context?: OperationContext) {
    if (!input.authorization.evidence.trim() || !input.authorization.grantedBy.trim()) throw new Error("Qwen3 voice enrollment requires explicit authorization evidence");
    const referenceText = input.referenceText?.trim() || undefined;
    if (!referenceText && !input.allowEmbeddingOnly) throw new Error("Qwen3 high-quality voice cloning requires exact referenceText for the selected audio range; embedding-only mode must be explicitly opted into");
    if (!referenceText && !CLONE_REFERENCE_POLICY.embeddingOnlySupported) throw new Error("Qwen3 embedding-only cloning is unavailable in this adapter");
    if (input.referenceRangeSeconds) {
      const duration = input.referenceRangeSeconds.end - input.referenceRangeSeconds.start;
      if (!(duration >= CLONE_REFERENCE_POLICY.minDurationSeconds && duration <= CLONE_REFERENCE_POLICY.maxDurationSeconds)) throw new Error(`Qwen3 voice reference must be ${CLONE_REFERENCE_POLICY.minDurationSeconds}-${CLONE_REFERENCE_POLICY.maxDurationSeconds} seconds`);
    }
    await this.ensureRoot();
    const voiceId = `qwen3-${randomUUID()}`; const directory = this.dir(voiceId); const referenceAudio = path.join(directory, "reference.wav");
    await mkdir(directory, { recursive: false });
    try {
      await this.extractReference(input, referenceAudio, context);
      const manifest: StoredVoiceManifest = { schemaVersion: 1, id: voiceId, name: input.name, referenceAudio, ...(referenceText ? { referenceText } : {}), referenceAssetId: input.referenceAssetId, languages: input.languages, createdAt: new Date().toISOString(), origin: "authorized-clone", xVectorOnly: !referenceText, ...(input.referenceRangeSeconds ? { referenceRangeSeconds: input.referenceRangeSeconds } : {}) };
      await writeFile(this.manifestPath(voiceId), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      return { providerVoiceId: voiceId, model: this.model, providerMetadata: { local: true, cloneMode: referenceText ? "icl-reference-text" : "x-vector-only", referenceRangeSeconds: input.referenceRangeSeconds ?? { start: 0, end: CLONE_REFERENCE_POLICY.maxDurationSeconds } } };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  private async cloneToFile(input: TTSInput, outputPath: string, context?: OperationContext): Promise<TTSFileResult> {
    if (context?.signal?.aborted) throw cancelled(context.signal);
    if (input.speed !== undefined && Math.abs(input.speed - 1) > 0.001) throw new Error("Qwen3 local clone adapter does not implement speed control; use timeline duration fitting/rewrite instead");
    const text = this.validateText(input.text); const manifest = await this.readManifest(input.voiceId);
    await mkdir(path.dirname(outputPath), { recursive: true });
    try { await access(outputPath); throw new Error("Qwen3-TTS output already exists"); } catch (error) { if (error instanceof Error && error.message === "Qwen3-TTS output already exists") throw error; }
    const args = [this.script(), "--mode", "clone", "--model", this.model, "--text", text, "--language", qwenLanguage(input.language), "--output", outputPath, "--ref-audio", manifest.referenceAudio];
    if (manifest.referenceText) args.push("--ref-text", manifest.referenceText);
    context?.onProgress?.(0.08, "tts-loading", `Loading ${this.model}`);
    const result = await runProcess(this.python, args, { timeoutMs: this.timeoutMs, maxOutputBytes: 2 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
    if (result.exitCode !== 0) { await rm(outputPath, { force: true }); throw new Error(`Qwen3-TTS clone failed: ${result.stderr.slice(-4_000)}`); }
    const metadata = JSON.parse(result.stdout) as { durationSeconds: number; sampleRate: number };
    if (!(metadata.durationSeconds > 0) || !(metadata.sampleRate > 0)) { await rm(outputPath, { force: true }); throw new Error("Qwen3-TTS returned invalid audio metadata"); }
    context?.onProgress?.(1, "tts-complete", "Qwen3 cloned speech generated");
    return { format: "wav", durationSeconds: metadata.durationSeconds, sampleRate: metadata.sampleRate, wordTimings: [], model: this.model, voiceId: input.voiceId, license: QWEN3_TTS_LICENSE };
  }

  async synthesizeToFile(input: TTSInput & { outputUri: string }, context?: OperationContext) { return this.cloneToFile(input, input.outputUri, context); }
  async synthesize(input: TTSInput, context?: OperationContext): Promise<TTSResult> {
    const directory = path.join(os.tmpdir(), `video-agent-qwen3-tts-${randomUUID()}`); const output = path.join(directory, "speech.wav"); await mkdir(directory, { recursive: true });
    try { const metadata = await this.cloneToFile(input, output, context); return { ...metadata, audio: await readFile(output) }; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  async designVoice(input: VoiceDesignRequest, context?: OperationContext) {
    const sampleText = this.validateText(input.sampleText); await this.ensureRoot();
    const voiceId = `qwen3-${randomUUID()}`; const directory = this.dir(voiceId); const referenceAudio = path.join(directory, "reference.wav"); await mkdir(directory, { recursive: false });
    const instruction = [input.description, input.tone && `tone: ${input.tone}`, input.pace && `pace: ${input.pace}`, input.agePresentation && `age: ${input.agePresentation}`, input.energy && `energy: ${input.energy}`, input.style && `style: ${input.style}`].filter(Boolean).join("; ");
    try {
      const args = [this.script(), "--mode", "design", "--model", this.designModel, "--text", sampleText, "--language", qwenLanguage(input.language), "--instruct", instruction, "--output", referenceAudio];
      context?.onProgress?.(0.05, "voice-design-loading", `Loading ${this.designModel}`);
      const result = await runProcess(this.python, args, { timeoutMs: this.timeoutMs, maxOutputBytes: 2 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
      if (result.exitCode !== 0) throw new Error(`Qwen3 voice design failed: ${result.stderr.slice(-4_000)}`);
      const metadata = JSON.parse(result.stdout) as { durationSeconds: number; sampleRate: number };
      const manifest: StoredVoiceManifest = { schemaVersion: 1, id: voiceId, name: input.description.slice(0, 80), referenceAudio, referenceText: sampleText, languages: [input.language], createdAt: new Date().toISOString(), origin: "voice-design", xVectorOnly: false };
      await writeFile(this.manifestPath(voiceId), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      const audio = await readFile(referenceAudio);
      return { providerVoiceId: voiceId, model: this.designModel, sample: { audio, format: "wav" as const, durationSeconds: metadata.durationSeconds, sampleRate: metadata.sampleRate, wordTimings: [], model: this.designModel, voiceId, license: QWEN3_TTS_LICENSE }, providerMetadata: { local: true, workflow: "voice-design-then-clone", cloneModel: this.model } };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  async deleteVoice(providerVoiceId: string) { await rm(this.dir(providerVoiceId), { recursive: true, force: true }); }

  async health() {
    try {
      const [python, ffmpeg] = await Promise.all([
        runProcess(this.python, ["-c", "import qwen_tts, torch, soundfile; print('ready')"], { timeoutMs: 10_000, maxOutputBytes: 100_000 }),
        runProcess(this.ffmpeg, ["-version"], { timeoutMs: 5_000, maxOutputBytes: 100_000 }),
      ]);
      const ready = python.exitCode === 0 && ffmpeg.exitCode === 0;
      return { id: this.id, status: ready ? "ready" as const : "unavailable" as const, message: ready ? `${this.model} runtime installed; weights load on demand` : `${python.stderr.slice(-300)} ${ffmpeg.stderr.slice(-300)}`.trim(), capabilities: this.voiceCapabilities() };
    } catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error), capabilities: this.voiceCapabilities() }; }
  }
}
