import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore, secondsToUs } from "../packages/core/src/index.js";
import { FakeASRProvider, FakeLLMProvider, FakeRenderer, FakeTTSProvider } from "../packages/providers/src/index.js";
import { VideoAgentCore } from "../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("offline runtime workflow", () => {
  it("runs transcript -> approved strategy -> plan -> version -> preview -> feedback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-test-"));
    roots.push(root);
    const store = new ProjectStore(root);
    const core = new VideoAgentCore(store, { asr: new FakeASRProvider(), tts: new FakeTTSProvider(), planner: new FakeLLMProvider(), renderer: new FakeRenderer() });
    const { project } = await core.createProject("Interview");
    const source = { id: "source-1", kind: "source_video" as const, originalName: "interview.mp4", relativePath: "assets/interview.mp4", sha256: "b".repeat(64), metadata: { durationUs: secondsToUs(1200), sizeBytes: 100 }, createdAt: new Date().toISOString() };
    await store.writeProject({ ...project, assets: [source] });
    await core.workflow.move(project.id, "INGESTING");
    const transcript = await core.transcribe(project.id, source.id, { prompt: "AI products fail because teams optimize models. Reliable workflows create useful products. The strongest conclusion belongs at the beginning." });
    expect(transcript.words.length).toBeGreaterThan(5);
    expect((await core.transcribe(project.id, source.id, { prompt: "AI products fail because teams optimize models. Reliable workflows create useful products. The strongest conclusion belongs at the beginning." })).id).toBe(transcript.id);
    const strategy = await core.proposeStrategy(project.id, "Make a 60 second hook-first short", secondsToUs(60));
    expect(strategy.status).toBe("proposed");
    await core.approveStrategy(project.id, strategy.id);
    const plan = await core.createEditPlan(project.id);
    expect((await core.validatePlan(project.id, plan.id)).valid).toBe(true);
    const version = await core.applyPlan(project.id, plan.id);
    expect(version.version).toBe(1);
    const preview = await core.renderPreview(project.id);
    expect(preview.selfCheck.passed).toBe(true);
    const narration = await core.addNarration(project.id, { text: "A sharper opening", voiceId: "fake-neutral", language: "en", timelineInUs: 0 });
    const narratedTimeline = await store.readTimeline(project.id);
    const narrationOutUs = narration.version.timeline.tracks.find((track) => track.type === "narration")!.clips[0]!.timelineOutUs;
    const overlappingCaptions = narratedTimeline.tracks.find((track) => track.type === "caption")!.clips.filter((clip) => clip.timelineInUs < narrationOutUs && clip.timelineOutUs > 0);
    expect(overlappingCaptions.length).toBeGreaterThan(0);
    expect(overlappingCaptions.every((clip) => clip.metadata?.source === "tts")).toBe(true);
    const feedback = await core.submitFeedback(project.id, "0~2 秒太慢");
    expect(feedback.category).toBe("pace");
    const diagnosis = await core.diagnose(project.id);
    expect(diagnosis.recommendedAction).toBe("PATCH");
    expect(await core.listVersions(project.id)).toHaveLength(2);
  });

  it("recovers an interrupted workflow step as FAILED", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-recovery-"));
    roots.push(root);
    const store = new ProjectStore(root);
    const core = new VideoAgentCore(store, { asr: new FakeASRProvider(), tts: new FakeTTSProvider(), planner: new FakeLLMProvider(), renderer: new FakeRenderer() });
    const { project, workflow } = await core.createProject("Recovery");
    await store.writeWorkflow(project.id, { ...workflow, state: "INGESTING", steps: [{ id: "step", from: "CREATED", to: "INGESTING", status: "running", retryCount: 0, startedAt: new Date().toISOString() }], updatedAt: new Date().toISOString() });
    const recovered = await core.workflow.recover(project.id);
    expect(recovered.state).toBe("FAILED");
    expect(recovered.steps[0]).toMatchObject({ status: "failed", retryCount: 1 });
  });
});
