import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ASRProvider, ASRResult, OperationContext, TTSProvider, TTSResult } from "../../providers/src/contracts.js";
import { runProcess } from "../../media/src/process.js";

export class Qwen3ASRProvider implements ASRProvider {
  readonly id = "qwen3-asr";

  constructor(
    readonly model = "Qwen/Qwen3-ASR-0.6B",
    private readonly python = process.env.VIDEO_AGENT_PYTHON ?? "python",
    private readonly forcedAligner = process.env.VIDEO_AGENT_QWEN3_ALIGNER ?? "Qwen/Qwen3-ForcedAligner-0.6B",
    private readonly timeoutMs = 60 * 60_000,
  ) {}

  capabilities() {
    return {
      wordTimestamps: Boolean(this.forcedAligner),
      segmentTimestamps: Boolean(this.forcedAligner),
      speakerDiarization: false,
      languageDetection: true,
      streaming: false,
      confidence: false,
      forcedAlignment: Boolean(this.forcedAligner),
    };
  }

  async transcribe(inputPath: string, options?: { language?: string; prompt?: string }, context?: OperationContext): Promise<ASRResult> {
    const script = path.resolve(import.meta.dirname, "../python/qwen3_asr_sidecar.py");
    const args = [script, "--input", path.resolve(inputPath), "--model", this.model];
    if (this.forcedAligner) args.push("--forced-aligner", this.forcedAligner);
    if (options?.language) args.push("--language", options.language);
    if (options?.prompt) args.push("--context", options.prompt);
    context?.onProgress?.(0.05, "loading-model", `Loading ${this.model}`);
    const result = await runProcess(this.python, args, {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: 10 * 1024 * 1024,
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`Qwen3-ASR failed (${result.exitCode}): ${result.stderr.slice(-4000)}`);
    context?.onProgress?.(0.95, "normalizing", "Parsing Qwen3-ASR result");
    try { return JSON.parse(result.stdout) as ASRResult; }
    catch (error) { throw new Error(`Qwen3-ASR returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async health() {
    try {
      const result = await runProcess(this.python, ["-c", "from qwen_asr import Qwen3ASRModel; print('ready')"], { timeoutMs: 10_000, maxOutputBytes: 100_000 });
      return {
        id: this.id,
        status: result.exitCode === 0 ? "ready" as const : "unavailable" as const,
        message: result.exitCode === 0 ? `${this.model} runtime installed` : result.stderr.slice(-500),
        capabilities: this.capabilities(),
      };
    } catch (error) {
      return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error), capabilities: this.capabilities() };
    }
  }
}

export class Qwen3TTSProvider implements TTSProvider {
  readonly id = "qwen3-tts";

  constructor(
    readonly model = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    private readonly python = process.env.VIDEO_AGENT_PYTHON ?? "python",
    private readonly timeoutMs = 30 * 60_000,
  ) {}

  capabilities() {
    return {
      streaming: false,
      voiceSelection: true,
      voiceCloning: false,
      styleControl: true,
      speedControl: false,
      multilingual: true,
      timestamps: false,
      phonemeAlignment: false,
    };
  }

  async synthesize(input: { text: string; voiceId: string; language: string; speed?: number }, context?: OperationContext): Promise<TTSResult> {
    const outputPath = path.resolve(process.env.VIDEO_AGENT_TMP ?? process.cwd(), `.qwen3-tts-${crypto.randomUUID()}.wav`);
    const script = path.resolve(import.meta.dirname, "../python/qwen3_tts_sidecar.py");
    context?.onProgress?.(0.05, "tts-loading", `Loading ${this.model}`);
    try {
      const args = [
        script,
        "--text", input.text,
        "--speaker", input.voiceId,
        "--language", input.language,
        "--model", this.model,
        "--output", outputPath,
      ];
      const result = await runProcess(this.python, args, {
        timeoutMs: this.timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (result.exitCode !== 0) throw new Error(`Qwen3-TTS failed (${result.exitCode}): ${result.stderr.slice(-4000)}`);
      const metadata = JSON.parse(result.stdout) as { durationSeconds: number; sampleRate: number };
      context?.onProgress?.(0.95, "tts-finalizing", "Reading generated speech segment");
      return {
        audio: await readFile(outputPath),
        format: "wav",
        durationSeconds: metadata.durationSeconds,
        sampleRate: metadata.sampleRate,
        wordTimings: [],
        model: this.model,
        voiceId: input.voiceId,
      };
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(outputPath, { force: true }));
    }
  }

  async health() {
    try {
      const result = await runProcess(this.python, ["-c", "from qwen_tts import Qwen3TTSModel; print('ready')"], { timeoutMs: 10_000, maxOutputBytes: 100_000 });
      return {
        id: this.id,
        status: result.exitCode === 0 ? "ready" as const : "unavailable" as const,
        message: result.exitCode === 0 ? `${this.model} runtime installed` : result.stderr.slice(-500),
        capabilities: this.capabilities(),
      };
    } catch (error) {
      return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error), capabilities: this.capabilities() };
    }
  }
}
