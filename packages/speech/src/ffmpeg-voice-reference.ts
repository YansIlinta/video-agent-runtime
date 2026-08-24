import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../../media/src/index.js";
import type { OperationContext, VoiceReferenceAcousticAnalyzer, VoiceReferenceRangeAcousticMetrics } from "../../providers/src/contracts.js";

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms
const MAX_RANGE_US = 20_000_000;
const CLIP_THRESHOLD = 32_700;

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function percentile(values: number[], ratio: number) {
  if (!values.length) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))]!;
}
function powerToDbfs(power: number) { return power <= 0 ? -120 : 10 * Math.log10(power / (32_768 * 32_768)); }

function analyzePcm(data: Uint8Array, startUs: number, endUs: number): VoiceReferenceRangeAcousticMetrics {
  const sampleCount = Math.floor(data.byteLength / 2);
  if (sampleCount < FRAME_SAMPLES) throw new Error("Voice reference acoustic sample is too short");
  const view = new DataView(data.buffer, data.byteOffset, sampleCount * 2);
  let totalPower = 0; let clipped = 0; let peak = 0;
  const frameDb: number[] = [];

  for (let frameStart = 0; frameStart < sampleCount; frameStart += FRAME_SAMPLES) {
    const frameEnd = Math.min(sampleCount, frameStart + FRAME_SAMPLES);
    let framePower = 0;
    for (let index = frameStart; index < frameEnd; index += 1) {
      const sample = view.getInt16(index * 2, true); const magnitude = Math.abs(sample); const power = sample * sample;
      totalPower += power; framePower += power; if (magnitude >= CLIP_THRESHOLD) clipped += 1; if (magnitude > peak) peak = magnitude;
    }
    frameDb.push(powerToDbfs(framePower / Math.max(1, frameEnd - frameStart)));
  }

  const noiseFloorDb = percentile(frameDb, 0.15);
  const speechLevelDb = percentile(frameDb, 0.75);
  const snrDb = clamp(speechLevelDb - noiseFloorDb, 0, 60);
  const silenceThresholdDb = Math.min(-35, noiseFloorDb + 6);
  const silenceRatio = frameDb.filter((value) => value <= silenceThresholdDb).length / frameDb.length;

  // Lightweight decay-tail proxy: it is intentionally not advertised as RT60. We only use it to
  // prefer cleaner clone references without loading a room-acoustics model.
  const tails: number[] = [];
  const span = Math.max(8, speechLevelDb - noiseFloorDb);
  for (let index = 0; index + 3 < frameDb.length; index += 1) {
    const current = frameDb[index]!; const next = frameDb[index + 1]!;
    if (current < noiseFloorDb + 15 || current - next < 6) continue;
    const tail = frameDb.slice(index + 1, Math.min(frameDb.length, index + 11));
    const persistence = tail.reduce((sum, value) => sum + clamp((value - noiseFloorDb) / span, 0, 1), 0) / tail.length;
    tails.push(persistence);
  }
  const reverbScore = clamp(tails.length ? tails.reduce((sum, value) => sum + value, 0) / tails.length : 0, 0, 1);
  const clippingRatio = clipped / sampleCount;
  const rmsDbfs = powerToDbfs(totalPower / sampleCount);
  const peakDbfs = peak <= 0 ? -120 : 20 * Math.log10(peak / 32_768);
  const warnings: string[] = [];
  if (snrDb < 10) warnings.push("low acoustic SNR proxy");
  if (clippingRatio > 0.002) warnings.push("clipping detected");
  if (silenceRatio > 0.35) warnings.push("reference contains substantial silence");
  if (reverbScore > 0.65) warnings.push("persistent room tail detected");
  return { startUs, endUs, snrDb, clippingRatio, silenceRatio, reverbScore, rmsDbfs, peakDbfs, warnings };
}

export class FFmpegVoiceReferenceAnalyzer implements VoiceReferenceAcousticAnalyzer {
  readonly id = "ffmpeg-voice-reference";
  constructor(private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg") {}

  async analyzeRanges(inputPath: string, ranges: Array<{ startUs: number; endUs: number }>, context?: OperationContext) {
    const unique = ranges.filter((range, index, all) => range.endUs > range.startUs && range.endUs - range.startUs <= MAX_RANGE_US && all.findIndex((item) => item.startUs === range.startUs && item.endUs === range.endUs) === index);
    if (!unique.length) return [];
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-agent-voice-acoustic-"));
    const metrics: VoiceReferenceRangeAcousticMetrics[] = [];
    try {
      for (let index = 0; index < unique.length; index += 1) {
        if (context?.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error("Voice reference analysis cancelled");
        const range = unique[index]!; const output = path.join(directory, `${index}.pcm`); const startSeconds = range.startUs / 1_000_000; const durationSeconds = (range.endUs - range.startUs) / 1_000_000;
        context?.onProgress?.(0.1 + 0.75 * index / unique.length, "voice-acoustic", `Analyzing reference candidate ${index + 1}/${unique.length}`);
        const result = await runProcess(this.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(startSeconds), "-i", inputPath, "-t", String(durationSeconds), "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", output], { timeoutMs: 120_000, maxOutputBytes: 1_000_000, ...(context?.signal ? { signal: context.signal } : {}) });
        if (result.exitCode !== 0) throw new Error(`Voice acoustic extraction failed: ${result.stderr.slice(-2_000)}`);
        metrics.push(analyzePcm(await readFile(output), range.startUs, range.endUs));
      }
      context?.onProgress?.(0.9, "voice-acoustic", "Acoustic candidate measurements complete");
      return metrics;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async health() {
    try { const result = await runProcess(this.ffmpeg, ["-version"], { timeoutMs: 5_000, maxOutputBytes: 100_000 }); return { id: this.id, status: result.exitCode === 0 ? "ready" as const : "unavailable" as const, message: result.exitCode === 0 ? "FFmpeg bounded acoustic analysis available" : result.stderr.slice(-300) }; }
    catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error) }; }
  }
}
