import type { MediaMetadata } from "./types.js";
import { secondsToUs } from "../../core/src/index.js";
import { runProcess } from "./process.js";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; format_name?: string; size?: string };
}

function parseRational(value?: string): { numerator: number; denominator: number } | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!numerator || !denominator) return undefined;
  return { numerator, denominator };
}

export async function probeMedia(filePath: string, ffprobe = process.env.FFPROBE_PATH ?? "ffprobe"): Promise<MediaMetadata> {
  const result = await runProcess(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`ffprobe failed: ${result.stderr.slice(-4000)}`);
  const parsed = JSON.parse(result.stdout) as ProbeOutput;
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Media has no positive duration");
  return {
    durationUs: secondsToUs(duration),
    ...(video?.width ? { width: video.width } : {}),
    ...(video?.height ? { height: video.height } : {}),
    ...(parseRational(video?.avg_frame_rate) ? { frameRate: parseRational(video?.avg_frame_rate)! } : {}),
    ...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
    ...(audio?.sample_rate ? { sampleRate: Number(audio.sample_rate) } : {}),
    ...(audio?.channels ? { channels: audio.channels } : {}),
    ...(parsed.format?.format_name ? { formatName: parsed.format.format_name } : {}),
    sizeBytes: Number(parsed.format?.size ?? 0),
  };
}
