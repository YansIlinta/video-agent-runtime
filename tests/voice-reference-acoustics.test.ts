import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../packages/media/src/index.js";
import { FFmpegVoiceReferenceAnalyzer } from "../packages/speech/src/ffmpeg-voice-reference.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-version"], { windowsHide: true }).status === 0;

describe("FFmpeg voice reference acoustics", () => {
  it.skipIf(!ffmpegAvailable)("measures only the requested bounded range without a speech model", async () => {
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-acoustic-test-")); roots.push(root);
    const source = path.join(root, "fixture.wav");
    const generated = await runProcess(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.5",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.5",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map", "[out]", "-c:a", "pcm_s16le", source,
    ], { timeoutMs: 30_000, maxOutputBytes: 1_000_000 });
    expect(generated.exitCode).toBe(0);

    const [metric] = await new FFmpegVoiceReferenceAnalyzer(ffmpeg).analyzeRanges(source, [{ startUs: 0, endUs: 3_000_000 }]);
    expect(metric).toBeDefined();
    expect(metric!.startUs).toBe(0);
    expect(metric!.endUs).toBe(3_000_000);
    expect(Number.isFinite(metric!.snrDb)).toBe(true);
    expect(Number.isFinite(metric!.rmsDbfs)).toBe(true);
    expect(metric!.clippingRatio).toBeLessThan(0.01);
    expect(metric!.silenceRatio).toBeGreaterThan(0.05);
    expect(metric!.warnings).not.toContain("clipping detected");
  });

  it.skipIf(!ffmpegAvailable)("ignores unbounded ranges instead of decoding a long source", async () => {
    const analyzer = new FFmpegVoiceReferenceAnalyzer(process.env.FFMPEG_PATH ?? "ffmpeg");
    await expect(analyzer.analyzeRanges("does-not-need-to-exist.wav", [{ startUs: 0, endUs: 21_000_000 }])).resolves.toEqual([]);
  });
});
