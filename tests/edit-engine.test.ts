import { describe, expect, it } from "vitest";
import { diffTimelines, timelineFromPlan, validateEditPlan, type EditPlan, type Project, type Timeline } from "../packages/core/src/index.js";

const now = new Date().toISOString();
const project: Project = { schemaVersion: 1, id: "project-123", name: "Test", createdAt: now, updatedAt: now, assets: [{ id: "asset", kind: "source_video", originalName: "input.mp4", relativePath: "assets/input.mp4", sha256: "a".repeat(64), metadata: { durationUs: 60_000_000, sizeBytes: 10 }, createdAt: now }], activeVersion: 0, workflowRunId: "workflow" };
const timeline: Timeline = { schemaVersion: 1, id: "timeline", projectId: project.id, frameRate: { numerator: 30, denominator: 1 }, width: 1080, height: 1920, durationUs: 0, tracks: [], updatedAt: now };

function plan(overrides: Partial<EditPlan> = {}): EditPlan {
  return { schemaVersion: 1, id: "plan", projectId: project.id, goal: "short", strategyId: "strategy", segments: [{ id: "clip", assetId: "asset", sourceInUs: 1_000_000, sourceOutUs: 6_000_000, timelineInUs: 0, speed: 1, reason: "hook", transcriptSegmentIds: [] }], captions: { enabled: false, style: "minimal" }, audio: { normalize: true, originalAudio: "keep", originalGainDb: 0, ducking: { enabled: false, targetGainDb: -12 } }, reason: "test", basedOnVersion: 0, feedbackIds: [], createdAt: now, ...overrides };
}

describe("edit validation and application", () => {
  it("detects overlap and stale versions", () => {
    const overlapping = plan({ segments: [...plan().segments, { ...plan().segments[0]!, id: "clip2", timelineInUs: 1_000_000 }] });
    expect(validateEditPlan(overlapping, project, project.assets).issues.map((issue) => issue.code)).toContain("timeline_overlap");
    expect(validateEditPlan(plan({ basedOnVersion: 2 }), project, project.assets).issues.map((issue) => issue.code)).toContain("stale_version");
  });

  it("builds deterministic tracks and a readable diff", () => {
    const next = timelineFromPlan(plan(), timeline);
    expect(next.durationUs).toBe(5_000_000);
    expect(next.tracks.map((track) => track.type)).toEqual(["video", "original_audio"]);
    const diff = diffTimelines(timeline, next, 0, 1, "apply");
    expect(diff.added.length).toBe(2);
    expect(diff.reason).toBe("apply");
  });
});
