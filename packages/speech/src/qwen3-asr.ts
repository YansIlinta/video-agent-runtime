import path from "node:path";
import type { ASRProvider, ASRResult, OperationContext } from "../../providers/src/contracts.js";
import { runProcess } from "../../media/src/index.js";

export class Qwen3ASRProvider implements ASRProvider {
  readonly id = "qwen3-asr";
  constructor(
    readonly model = "Qwen/Qwen3-ASR-0.6B",
    private readonly aligner = "Qwen/Qwen3-ForcedAligner-0.6B",
    private readonly python = process.env.VIDEO_AGENT_PYTHON ?? "python",
    private readonly timeoutMs = 3_600_000,
    private readonly maxNewTokens = 2_048,
  ) {
    if (!aligner.trim()) throw new Error("Qwen3ASRProvider requires Qwen3 ForcedAligner timestamps; text-only ASR is not edit-safe");
  }

  capabilities() {
    return { wordTimestamps: true, segmentTimestamps: true, speakerDiarization: false, languageDetection: true, streaming: false, confidence: false, forcedAlignment: true };
  }

  async transcribe(inputPath: string, options: { language?: string; prompt?: string } = {}, context?: OperationContext): Promise<ASRResult> {
    if (context?.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error("Qwen3 ASR cancelled");
    const script = path.resolve(import.meta.dirname, "../python/qwen3_asr_sidecar.py");
    const args = [script, "--input", path.resolve(inputPath), "--model", this.model, "--aligner", this.aligner, "--max-new-tokens", String(this.maxNewTokens)];
    if (options.language) args.push("--language", options.language);
    if (options.prompt) args.push("--prompt", options.prompt);
    context?.onProgress?.(0.03, "loading-model", `Loading ${this.model} + ${this.aligner}`);
    const result = await runProcess(this.python, args, { timeoutMs: this.timeoutMs, maxOutputBytes: 64 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
    if (result.exitCode !== 0) throw new Error(`Qwen3-ASR sidecar failed (${result.exitCode}): ${result.stderr.slice(-4_000)}`);
    context?.onProgress?.(0.96, "normalizing", "Parsing Qwen3 forced-alignment result");
    let parsed: ASRResult;
    try { parsed = JSON.parse(result.stdout) as ASRResult; }
    catch (error) { throw new Error(`Qwen3-ASR returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (!parsed.segments.length || parsed.segments.some((segment) => !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) || segment.endSeconds <= segment.startSeconds)) throw new Error("Qwen3-ASR returned no usable timestamped segments");
    if (parsed.segments.every((segment) => segment.words.length === 0)) throw new Error("Qwen3-ASR ForcedAligner returned no timestamp units");
    context?.onProgress?.(1, "complete", "Qwen3 transcription complete");
    return parsed;
  }

  async health() {
    try {
      const result = await runProcess(this.python, ["-c", "import qwen_asr, torch; print('ready')"], { timeoutMs: 10_000, maxOutputBytes: 100_000 });
      return { id: this.id, status: result.exitCode === 0 ? "ready" as const : "unavailable" as const, message: result.exitCode === 0 ? `${this.model} runtime installed; weights load lazily` : result.stderr.slice(-500), capabilities: this.capabilities() };
    } catch (error) {
      return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error), capabilities: this.capabilities() };
    }
  }
}
