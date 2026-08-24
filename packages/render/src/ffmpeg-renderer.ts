import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatTimecode, usToSeconds } from "../../core/src/index.js";
import { probeMedia, runProcess } from "../../media/src/index.js";
import type { RenderRequest, Renderer, RenderResult } from "../../providers/src/index.js";

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function srtTimestamp(timeUs: number): string {
  const value = formatTimecode(timeUs).replace(".", ",");
  return value;
}

async function writeCaptions(request: RenderRequest): Promise<string | undefined> {
  const captionTrack = request.timeline.tracks.find((track) => track.type === "caption" && !track.muted);
  if (!captionTrack || captionTrack.clips.length === 0) return undefined;
  const sorted = [...captionTrack.clips].sort((a, b) => a.timelineInUs - b.timelineInUs);
  const entries = sorted.map((clip, index) => `${index + 1}\n${srtTimestamp(clip.timelineInUs)} --> ${srtTimestamp(clip.timelineOutUs)}\n${(clip.text ?? "").replace(/\r?\n/g, " ")}\n`).join("\n");
  const filePath = `${request.outputPath}.captions.srt`;
  await writeFile(filePath, entries, "utf8");
  return filePath;
}

export class FFmpegRenderer implements Renderer {
  readonly id = "ffmpeg";
  constructor(private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg") {}

  renderPreview(request: Omit<RenderRequest, "mode">): Promise<RenderResult> {
    return this.render({ ...request, mode: "preview" });
  }

  renderFinal(request: Omit<RenderRequest, "mode">): Promise<RenderResult> {
    return this.render({ ...request, mode: "final" });
  }

  private async render(request: RenderRequest): Promise<RenderResult> {
    await mkdir(path.dirname(request.outputPath), { recursive: true });
    const videoTrack = request.timeline.tracks.find((track) => track.type === "video" && !track.muted);
    if (!videoTrack || videoTrack.clips.length === 0) throw new Error("Timeline has no video clips");
    const clips = [...videoTrack.clips].sort((a, b) => a.timelineInUs - b.timelineInUs);
    const tempOutput = `${request.outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;
    const args: string[] = ["-hide_banner", "-loglevel", "warning", "-progress", "pipe:2", "-nostats"];
    for (const clip of clips) {
      if (!clip.assetId) throw new Error(`Video clip ${clip.id} has no assetId`);
      args.push("-i", request.resolveAssetPath(clip.assetId));
    }
    const narrationClips = request.timeline.tracks
      .filter((track) => ["narration", "tts_replacement", "dubbing"].includes(track.type) && !track.muted)
      .flatMap((track) => track.clips)
      .sort((a, b) => a.timelineInUs - b.timelineInUs);
    for (const clip of narrationClips) {
      if (!clip.assetId) throw new Error(`Narration clip ${clip.id} has no assetId`);
      args.push("-i", request.resolveAssetPath(clip.assetId));
    }
    const filters: string[] = [];
    for (const [index, clip] of clips.entries()) {
      const start = usToSeconds(clip.sourceInUs).toFixed(6);
      const end = usToSeconds(clip.sourceOutUs).toFixed(6);
      const speed = clip.speed;
      filters.push(`[${index}:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${speed},scale=${request.timeline.width}:${request.timeline.height}:force_original_aspect_ratio=decrease,pad=${request.timeline.width}:${request.timeline.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${index}]`);
      filters.push(`[${index}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,atempo=${speed}[a${index}]`);
    }
    const concatInputs = clips.map((_, index) => `[v${index}][a${index}]`).join("");
    filters.push(`${concatInputs}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
    let videoLabel = "vcat";
    const videoDurationUs = Math.max(...clips.map((clip) => clip.timelineOutUs));
    if (request.timeline.durationUs > videoDurationUs) {
      filters.push(`[vcat]tpad=stop_mode=clone:stop_duration=${usToSeconds(request.timeline.durationUs - videoDurationUs).toFixed(6)}[vpadded]`);
      videoLabel = "vpadded";
    }
    let audioLabel = "acat";
    if (narrationClips.length > 0) {
      const narrationLabels: string[] = [];
      for (const [index, clip] of narrationClips.entries()) {
        const inputIndex = clips.length + index;
        const delayMs = Math.round(clip.timelineInUs / 1_000);
        filters.push(`[${inputIndex}:a]atrim=start=${usToSeconds(clip.sourceInUs).toFixed(6)}:end=${usToSeconds(clip.sourceOutUs).toFixed(6)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[n${index}]`);
        narrationLabels.push(`[n${index}]`);
      }
      if (narrationLabels.length === 1) filters.push(`${narrationLabels[0]}anull[narr]`);
      else filters.push(`${narrationLabels.join("")}amix=inputs=${narrationLabels.length}:duration=longest:normalize=0[narr]`);
      const originalTrack = request.timeline.tracks.find((track) => track.type === "original_audio");
      if (originalTrack?.ducking?.enabled) {
        filters.push(`[narr]asplit=2[narr_sc][narr_mix]`);
        filters.push(`[acat][narr_sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[ducked]`);
        filters.push(`[ducked][narr_mix]amix=inputs=2:duration=longest:normalize=0[aout]`);
      } else {
        filters.push(`[acat][narr]amix=inputs=2:duration=longest:normalize=0[aout]`);
      }
      audioLabel = "aout";
    }
    const captionsPath = await writeCaptions(request);
    if (captionsPath) filters.push(`[${videoLabel}]subtitles=filename='${escapeFilterPath(captionsPath)}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=42'[vout]`);
    args.push("-filter_complex", filters.join(";"), "-map", captionsPath ? "[vout]" : `[${videoLabel}]`, "-map", `[${audioLabel}]`);
    if (request.range) {
      args.push("-ss", usToSeconds(request.range.startUs).toFixed(6), "-t", usToSeconds(request.range.endUs - request.range.startUs).toFixed(6));
    }
    if (request.mode === "preview") args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-c:a", "aac", "-b:a", "96k");
    else args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k");
    args.push("-movflags", "+faststart", "-y", tempOutput);
    let progressBuffer = "";
    try {
      const expectedUs = request.range ? request.range.endUs - request.range.startUs : request.timeline.durationUs;
      const result = await runProcess(this.ffmpeg, args, { timeoutMs: request.mode === "preview" ? 20 * 60_000 : 2 * 60 * 60_000, maxOutputBytes: 20 * 1024 * 1024, ...(request.signal ? { signal: request.signal } : {}), onStderr: (text) => {
        progressBuffer += text;
        const lines = progressBuffer.split(/\r?\n/u); progressBuffer = lines.pop() ?? "";
        for (const line of lines) { const match = line.match(/^out_time_us=(\d+)$/u); if (match?.[1]) request.onProgress?.(Math.min(0.99, Number(match[1]) / Math.max(1, expectedUs)), "rendering", `${request.mode} render`); }
      } });
      if (result.exitCode !== 0) throw new Error(`FFmpeg render failed: ${result.stderr.slice(-6000)}`);
      const metadata = await probeMedia(tempOutput);
      await rm(request.outputPath, { force: true });
      await rename(tempOutput, request.outputPath);
      request.onProgress?.(1, "finalizing", `${request.mode} ready`);
      return { outputPath: request.outputPath, durationUs: metadata.durationUs, mode: request.mode, warnings: [] };
    } finally {
      await rm(tempOutput, { force: true });
      if (captionsPath) await rm(captionsPath, { force: true });
    }
  }

  async health() {
    try { const result = await runProcess(this.ffmpeg, ["-version"], { timeoutMs: 5_000, maxOutputBytes: 1_000_000 }); return { id: this.id, status: result.exitCode === 0 ? "ready" as const : "unavailable" as const, message: result.stdout.split(/\r?\n/u)[0] ?? "FFmpeg unavailable" }; }
    catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error) }; }
  }
}
