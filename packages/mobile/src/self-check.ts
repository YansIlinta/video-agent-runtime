import type { Timeline } from "../../core/src/schemas.js";
import type { LogicalUri } from "../../platform/src/contracts.js";
import type { NativeVideoHostBridge } from "./native-bridge.js";

/**
 * Mirrors the Node FFmpeg self-check through the native probe. Without it the mobile host fell back
 * to `warnings.length === 0` over renderer warnings, which verified nothing.
 */
export function createMobilePreviewSelfCheck(native: NativeVideoHostBridge) {
  return async (outputPath: string, timeline: Timeline, expectedDurationUs?: number): Promise<{ passed: boolean; warnings: string[] }> => {
    const uri = outputPath as LogicalUri;
    const warnings: string[] = [];
    let sizeBytes: number;
    try { sizeBytes = (await native.stat(uri)).sizeBytes; }
    catch { return { passed: false, warnings: ["Preview file was not written"] }; }
    if (sizeBytes <= 0) warnings.push("Preview file is empty");
    try {
      const metadata = await native.probe(uri);
      if (!metadata.videoCodec) warnings.push("Preview has no video stream");
      if (!metadata.audioCodec) warnings.push("Preview has no audio stream");
      // Prefer the duration the renderer reported: for a ranged preview the stored timeline is longer.
      const expected = expectedDurationUs ?? timeline.durationUs;
      const drift = Math.abs(metadata.durationUs - expected);
      if (drift > 500_000) warnings.push(`Preview duration differs from the rendered range by ${drift}us`);
    } catch (error) {
      warnings.push(`Preview could not be probed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const captionTrack = timeline.tracks.find((track) => track.type === "caption");
    if (captionTrack?.clips.some((clip) => !clip.text?.trim())) warnings.push("Timeline contains an empty caption");
    return { passed: warnings.length === 0, warnings };
  };
}
