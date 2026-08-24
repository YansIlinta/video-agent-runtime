import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alignmentResultSchema, diarizationResultSchema, type AlignmentResult, type DiarizationResult, type Transcript } from "../../core/src/index.js";
import { runProcess } from "../../media/src/index.js";
import type { AlignmentProvider, DiarizationProvider, OperationContext } from "../../providers/src/index.js";

export class WhisperXProvider implements AlignmentProvider, DiarizationProvider {
  readonly id = "whisperx";
  constructor(readonly model = "default", private readonly python = "python", private readonly hfToken?: string, private readonly timeoutMs = 60 * 60_000) {}

  async align(inputPath: string, transcript: Transcript, context?: OperationContext): Promise<AlignmentResult> {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-align-")); const transcriptPath = path.join(root, "transcript.json");
    try { await writeFile(transcriptPath, JSON.stringify(transcript), "utf8"); context?.onProgress?.(0.05, "alignment", "Loading WhisperX alignment model"); const result = await runProcess(this.python, [path.resolve(import.meta.dirname, "../python/whisperx_sidecar.py"), "align", "--input", inputPath, "--transcript", transcriptPath], { timeoutMs: this.timeoutMs, maxOutputBytes: 50 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) }); if (result.exitCode !== 0) throw new Error(`WhisperX alignment failed: ${result.stderr.slice(-4000)}`); return alignmentResultSchema.parse(JSON.parse(result.stdout)); }
    finally { await rm(root, { recursive: true, force: true }); }
  }

  async diarize(inputPath: string, context?: OperationContext): Promise<DiarizationResult> {
    if (!this.hfToken) throw new Error("HF_TOKEN is required for WhisperX diarization");
    context?.onProgress?.(0.05, "diarization", "Loading diarization model");
    const result = await runProcess(this.python, [path.resolve(import.meta.dirname, "../python/whisperx_sidecar.py"), "diarize", "--input", inputPath, "--hf-token", this.hfToken], { timeoutMs: this.timeoutMs, maxOutputBytes: 50 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
    if (result.exitCode !== 0) throw new Error(`WhisperX diarization failed: ${result.stderr.slice(-4000)}`);
    return diarizationResultSchema.parse(JSON.parse(result.stdout));
  }

  async health() { try { const result = await runProcess(this.python, ["-c", "import whisperx; print('ready')"], { timeoutMs: 10_000, maxOutputBytes: 100_000 }); return { id: this.id, status: result.exitCode === 0 ? "ready" as const : "unavailable" as const, message: result.exitCode === 0 ? "WhisperX runtime installed" : result.stderr.slice(-500) }; } catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error) }; } }
}
