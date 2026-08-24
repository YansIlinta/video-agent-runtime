import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { usToSeconds, type VisualEvidence } from "../../core/src/index.js";
import type { OperationContext, VisualEvidenceProvider } from "../../providers/src/index.js";
import { runProcess } from "./process.js";

export class FFmpegVisualEvidenceProvider implements VisualEvidenceProvider {
  readonly id = "ffmpeg-evidence";
  constructor(private readonly ffmpeg = "ffmpeg") {}

  async inspect(input: { projectId: string; assetId: string; inputPath: string; outputDirectory: string; range: { startUs: number; endUs: number } }, context?: OperationContext): Promise<VisualEvidence> {
    await mkdir(input.outputDirectory, { recursive: true });
    const durationUs = input.range.endUs - input.range.startUs;
    const sampleTimes = [...new Set([input.range.startUs, input.range.startUs + Math.round(durationUs / 2), Math.max(input.range.startUs, input.range.endUs - 100_000)])];
    const keyframes: VisualEvidence["keyframes"] = [];
    for (const [index, timeUs] of sampleTimes.entries()) {
      if (context?.signal?.aborted) throw new Error("Visual inspection cancelled");
      const relativePath = `analysis/visual/${randomUUID()}.jpg`; const outputPath = path.join(input.outputDirectory, path.basename(relativePath));
      const result = await runProcess(this.ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", usToSeconds(timeUs).toFixed(6), "-i", input.inputPath, "-frames:v", "1", "-q:v", "3", "-y", outputPath], { timeoutMs: 60_000, ...(context?.signal ? { signal: context.signal } : {}) });
      if (result.exitCode !== 0) throw new Error(`Keyframe extraction failed: ${result.stderr.slice(-1000)}`);
      keyframes.push({ id: randomUUID(), timeUs, relativePath });
      context?.onProgress?.((index + 1) / (sampleTimes.length + 1), "keyframes", `Extracted ${index + 1}/${sampleTimes.length}`);
    }
    const scene = await runProcess(this.ffmpeg, ["-hide_banner", "-ss", usToSeconds(input.range.startUs).toFixed(6), "-t", usToSeconds(durationUs).toFixed(6), "-i", input.inputPath, "-vf", "select='gt(scene,0.35)',showinfo", "-an", "-f", "null", "-"], { timeoutMs: 5 * 60_000, maxOutputBytes: 5 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
    const cuts = [...scene.stderr.matchAll(/pts_time:([0-9.]+)/gu)].map((match) => input.range.startUs + Math.round(Number(match[1]) * 1_000_000)).filter((timeUs) => timeUs > input.range.startUs && timeUs < input.range.endUs);
    const boundaries = [input.range.startUs, ...cuts, input.range.endUs];
    const shots = boundaries.slice(0, -1).map((startUs, index) => ({ id: randomUUID(), startUs, endUs: boundaries[index + 1]!, confidence: 0.65 }));
    context?.onProgress?.(1, "visual-summary", `Detected ${shots.length} shots`);
    return { schemaVersion: 1, id: randomUUID(), projectId: input.projectId, assetId: input.assetId, range: input.range, shots, keyframes, ocr: [], faceObservations: [], summary: `${shots.length} shot(s), ${keyframes.length} representative frame(s); OCR and face analysis were not requested.`, provider: this.id, createdAt: new Date().toISOString() };
  }

  async health() { try { const result = await runProcess(this.ffmpeg, ["-version"], { timeoutMs: 5_000, maxOutputBytes: 100_000 }); return { id: this.id, status: result.exitCode === 0 ? "ready" as const : "unavailable" as const, message: result.stdout.split(/\r?\n/u)[0] ?? "FFmpeg unavailable" }; } catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error) }; } }
}
