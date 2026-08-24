import { probeMedia } from "../../media/src/index.js";
import type { Timeline } from "../../core/src/index.js";

export async function selfCheckPreview(filePath: string, timeline: Timeline): Promise<{ passed: boolean; warnings: string[] }> {
  const metadata = await probeMedia(filePath);
  const warnings: string[] = [];
  if (!metadata.videoCodec) warnings.push("Preview has no video stream");
  if (!metadata.audioCodec) warnings.push("Preview has no audio stream");
  if (Math.abs(metadata.durationUs - timeline.durationUs) > 500_000) warnings.push(`Preview duration differs from timeline by ${Math.abs(metadata.durationUs - timeline.durationUs)}us`);
  const captionTrack = timeline.tracks.find((track) => track.type === "caption");
  if (captionTrack?.clips.some((clip) => !clip.text?.trim())) warnings.push("Timeline contains an empty caption");
  return { passed: warnings.length === 0, warnings };
}
