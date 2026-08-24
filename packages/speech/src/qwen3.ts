import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OperationContext, TTSFileResult, TTSInput, TTSProvider, TTSResult } from "../../providers/src/contracts.js";
import { runProcess } from "../../media/src/process.js";

export { Qwen3ASRProvider } from "./qwen3-asr.js";

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

  private script() { return path.resolve(import.meta.dirname, "../python/qwen3_tts_sidecar.py"); }

  private async customToFile(input: TTSInput, outputPath: string, context?: OperationContext): Promise<TTSFileResult> {
    if (context?.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error("Qwen3 TTS cancelled");
    if (input.speed !== undefined && Math.abs(input.speed - 1) > 0.001) throw new Error("Qwen3 CustomVoice adapter does not implement speed control");
    await mkdir(path.dirname(outputPath), { recursive: true });
    context?.onProgress?.(0.05, "tts-loading", `Loading ${this.model}`);
    const args = [
      this.script(),
      "--mode", "custom",
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
    if (result.exitCode !== 0) { await rm(outputPath, { force: true }); throw new Error(`Qwen3-TTS failed (${result.exitCode}): ${result.stderr.slice(-4000)}`); }
    const metadata = JSON.parse(result.stdout) as { durationSeconds: number; sampleRate: number };
    if (!(metadata.durationSeconds > 0) || !(metadata.sampleRate > 0)) { await rm(outputPath, { force: true }); throw new Error("Qwen3-TTS returned invalid audio metadata"); }
    context?.onProgress?.(1, "tts-complete", "Qwen3 CustomVoice speech generated");
    return { format: "wav", durationSeconds: metadata.durationSeconds, sampleRate: metadata.sampleRate, wordTimings: [], model: this.model, voiceId: input.voiceId };
  }

  async synthesizeToFile(input: TTSInput & { outputUri: string }, context?: OperationContext): Promise<TTSFileResult> {
    return this.customToFile(input, input.outputUri, context);
  }

  async synthesize(input: TTSInput, context?: OperationContext): Promise<TTSResult> {
    const directory = path.join(os.tmpdir(), `video-agent-qwen3-custom-${randomUUID()}`);
    const outputPath = path.join(directory, "speech.wav");
    await mkdir(directory, { recursive: true });
    try {
      const metadata = await this.customToFile(input, outputPath, context);
      return { ...metadata, audio: await readFile(outputPath) };
    } finally {
      await rm(directory, { recursive: true, force: true });
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
