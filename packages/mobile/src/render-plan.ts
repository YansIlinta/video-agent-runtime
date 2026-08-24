import type { Timeline } from "../../core/src/schemas.js";

/**
 * Output geometry and range selection are decided here rather than inside each native renderer.
 * Two native implementations previously each hardcoded 1280x720 and ignored the timeline; keeping
 * the policy portable means it is decided once and can be tested without a device.
 */

/** H.264/HEVC encoders on both platforms reject odd dimensions. */
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export interface OutputSize { width: number; height: number }

/** Final output matches the timeline exactly. Preview may be scaled down, never cropped. */
export function outputSize(timeline: Timeline, mode: "preview" | "final", previewMaxWidth: number): OutputSize {
  if (mode === "final" || timeline.width <= previewMaxWidth) return { width: even(timeline.width), height: even(timeline.height) };
  const scale = previewMaxWidth / timeline.width;
  return { width: even(previewMaxWidth), height: even(timeline.height * scale) };
}

/**
 * Restricts a timeline to [startUs, endUs) and rebases it to zero, so a ranged preview renders the
 * requested window instead of the whole programme. Callers must reject speed != 1 first: source and
 * timeline durations are treated as 1:1 here.
 */
export function sliceTimelineToRange(timeline: Timeline, range: { startUs: number; endUs: number }): Timeline {
  const start = Math.max(0, range.startUs);
  const end = Math.max(start, range.endUs);
  const tracks = timeline.tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) => {
      const from = Math.max(clip.timelineInUs, start);
      const to = Math.min(clip.timelineOutUs, end);
      if (to <= from) return [];
      const head = from - clip.timelineInUs;
      const tail = clip.timelineOutUs - to;
      return [{ ...clip, timelineInUs: from - start, timelineOutUs: to - start, sourceInUs: clip.sourceInUs + head, sourceOutUs: clip.sourceOutUs - tail }];
    }),
  }));
  return { ...timeline, durationUs: end - start, tracks };
}
