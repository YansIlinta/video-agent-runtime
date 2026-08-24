import { describe, expect, it } from "vitest";
import { z } from "zod";
import { diagnoseFeedback, normalizeFeedback, type Project } from "../packages/core/src/index.js";
import { fitTtsToRange, parseStructuredProviderOutput, withProviderTimeout } from "../packages/providers/src/index.js";

const now = new Date().toISOString();
const project: Project = { schemaVersion: 1, id: "project-123", name: "Test", createdAt: now, updatedAt: now, assets: [], activeVersion: 3, workflowRunId: "workflow" };

describe("feedback diagnosis", () => {
  it("normalizes category and range without losing raw text", () => {
    const feedback = normalizeFeedback(project, "20~35 秒太慢");
    expect(feedback.category).toBe("pace");
    expect(feedback.range).toEqual({ startUs: 20_000_000, endUs: 35_000_000 });
    expect(feedback.rawMessage).toBe("20~35 秒太慢");
  });

  it("escalates repeated flat opening feedback to strategy replan", () => {
    const feedback = ["没意思", "还是很平", "开头还是不抓人"].map((message, index) => ({ ...normalizeFeedback({ ...project, activeVersion: index + 1 }, message), createdAt: new Date(Date.now() + index).toISOString() }));
    const diagnosis = diagnoseFeedback(project.id, feedback, "chronological-summary");
    expect(diagnosis.recommendedAction).toBe("REPLAN");
    expect(diagnosis.rootCause).toBe("story_structure");
    expect(diagnosis.strategyChanges[0]).toMatchObject({ field: "structure", to: "hook-first" });
  });
});

describe("provider boundaries", () => {
  it("rejects malformed JSON and wrong schemas", () => {
    expect(() => parseStructuredProviderOutput("not json", z.object({ ok: z.boolean() }))).toThrow(/malformed JSON/);
    expect(() => parseStructuredProviderOutput('{"ok":"yes"}', z.object({ ok: z.boolean() }))).toThrow(/schema validation/);
  });

  it("times out stalled providers", async () => {
    await expect(withProviderTimeout(new Promise(() => undefined), 10)).rejects.toThrow(/timed out/);
  });

  it("does not force unintelligible TTS speed", () => {
    expect(fitTtsToRange(4.8, 3.2)).toMatchObject({ fits: false, requiresRewrite: true, requiresTimelineExtension: true, suggestedSpeed: 1.2 });
    expect(fitTtsToRange(3.4, 3.2)).toMatchObject({ fits: true, requiresRewrite: false });
  });
});
