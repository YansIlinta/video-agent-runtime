import { describe, expect, it } from "vitest";
import { applyPatchToPlan, timelineFromPlan, validateEditPatch, type EditPatch, type EditPlan, type Project, type Timeline } from "../packages/core/src/index.js";

const now = new Date().toISOString();
const project: Project = { schemaVersion: 1, id: "project-123", name: "Patch", createdAt: now, updatedAt: now, assets: [{ id: "asset", kind: "source_video", originalName: "a.mp4", relativePath: "assets/a.mp4", sha256: "a".repeat(64), metadata: { durationUs: 60_000_000, sizeBytes: 1 }, createdAt: now }], activeVersion: 1, workflowRunId: "workflow", activeEditPlanId: "plan" };
const base: Timeline = { schemaVersion: 1, id: "timeline", projectId: project.id, frameRate: { numerator: 30, denominator: 1 }, width: 1080, height: 1920, durationUs: 0, tracks: [], updatedAt: now };
const plan: EditPlan = { schemaVersion: 1, id: "plan", projectId: project.id, goal: "short", strategyId: "strategy", segments: [
  { id: "s1", assetId: "asset", sourceInUs: 0, sourceOutUs: 10_000_000, timelineInUs: 0, speed: 1, reason: "hook", transcriptSegmentIds: [] },
  { id: "s2", assetId: "asset", sourceInUs: 20_000_000, sourceOutUs: 30_000_000, timelineInUs: 10_000_000, speed: 1, reason: "body", transcriptSegmentIds: [] },
], captions: { enabled: false, style: "minimal" }, audio: { normalize: true, originalAudio: "keep", originalGainDb: 0, ducking: { enabled: false, targetGainDb: -12 } }, reason: "base", basedOnVersion: 0, feedbackIds: [], createdAt: now };
const timeline = timelineFromPlan(plan, base);

function patch(overrides: Partial<EditPatch> = {}): EditPatch { return { schemaVersion: 1, id: "patch", projectId: project.id, basedOnVersion: 1, feedbackIds: ["f1"], scope: { timelineRanges: [{ startUs: 0, endUs: 10_000_000 }], segmentIds: ["s1"], trackIds: ["video-main"] }, reason: "tighten local range", operations: [{ type: "trimSegment", segmentId: "s1", sourceOutUs: 8_000_000, reason: "remove slow tail" }], createdAt: now, ...overrides }; }

describe("EditPatch", () => {
  it("accepts a local minimal patch and preserves unrelated source selection", () => {
    const validation = validateEditPatch(patch(), project, plan, timeline, project.assets);
    expect(validation.valid).toBe(true);
    const next = applyPatchToPlan(plan, patch());
    expect(next.segments[0]!.sourceOutUs).toBe(8_000_000);
    expect(next.segments[1]!).toMatchObject({ id: "s2", sourceInUs: 20_000_000, sourceOutUs: 30_000_000 });
  });

  it("rejects out-of-scope and stale operations", () => {
    const invalid = patch({ basedOnVersion: 0, operations: [{ type: "removeSegment", segmentId: "s2", reason: "wrong scope" }] });
    expect(validateEditPatch(invalid, project, plan, timeline, project.assets).issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["stale_version", "target_outside_scope"]));
  });
});
