import { describe, expect, it } from "vitest";
import { editPlanSchema, formatTimecode, secondsToUs, timelineSchema, usToSeconds } from "../packages/core/src/index.js";

describe("time representation", () => {
  it("round-trips sub-second timestamps as integer microseconds", () => {
    expect(secondsToUs(12.320001)).toBe(12_320_001);
    expect(usToSeconds(12_320_001)).toBe(12.320001);
    expect(formatTimecode(3_723_004_000)).toBe("01:02:03.004");
  });
});

describe("schemas", () => {
  it("rejects invalid edit source ranges", () => {
    const result = editPlanSchema.safeParse({
      schemaVersion: 1,
      id: "plan",
      projectId: "project",
      goal: "short",
      strategyId: "strategy",
      segments: [{ id: "s", assetId: "a", sourceInUs: 20, sourceOutUs: 10, timelineInUs: 0, reason: "bad" }],
      captions: { enabled: true },
      audio: {},
      reason: "test",
      basedOnVersion: 0,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("materializes timeline defaults during parsing", () => {
    const timeline = timelineSchema.parse({ schemaVersion: 1, id: "timeline", projectId: "project", frameRate: { numerator: 30, denominator: 1 }, width: 1080, height: 1920, durationUs: 0, tracks: [{ id: "v", type: "video", name: "Video", clips: [] }], updatedAt: new Date().toISOString() });
    expect(timeline.tracks[0]).toMatchObject({ muted: false, gainDb: 0 });
  });
});
