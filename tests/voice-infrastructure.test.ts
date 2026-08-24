import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore, secondsToUs } from "../packages/core/src/index.js";
import { createApiHandler } from "../packages/api/src/index.js";
import { FakeASRProvider, FakeLLMProvider, FakeRenderer, FakeVoiceProvider, type OperationContext } from "../packages/providers/src/index.js";
import { VideoAgentCore } from "../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function readyCore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-voice-")); roots.push(root); const store = new ProjectStore(root); const voice = new FakeVoiceProvider(); const core = new VideoAgentCore(store, { asr: new FakeASRProvider(), tts: voice, voice, planner: new FakeLLMProvider(), renderer: new FakeRenderer() });
  const { project } = await core.createProject("Voice interview"); const source = { id: "source-voice", kind: "source_video" as const, originalName: "voice.mp4", relativePath: "assets/voice.mp4", sha256: "c".repeat(64), metadata: { durationUs: secondsToUs(20), sizeBytes: 100 }, createdAt: new Date().toISOString() }; await store.writeProject({ ...project, assets: [source] }); await core.workflow.move(project.id, "INGESTING"); const transcript = await core.transcribe(project.id, source.id, { prompt: "My own voice explains thirty important ideas clearly for this authorized interview sample with enough clean speech to create a useful reference" }); const strategy = await core.proposeStrategy(project.id, "Keep the interview", secondsToUs(20)); await core.approveStrategy(project.id, strategy.id); const plan = await core.createEditPlan(project.id); await core.applyPlan(project.id, plan.id); await core.renderPreview(project.id); return { core, store, projectId: project.id, source, transcript };
}

describe("voice identity infrastructure", () => {
  it("requires authorization and supports analysis, enrollment, preview, cache, replacement, dubbing, and deletion", async () => {
    const { core, store, projectId, source, transcript } = await readyCore(); const quality = await core.analyzeVoiceReference(projectId, source.id); expect(quality.candidates.length).toBeGreaterThan(0); expect(await core.analyzeVoiceReference(projectId, source.id)).toEqual(quality);
    await expect(core.enrollVoice(projectId, { assetId: source.id, name: "Mine", languages: ["en"], authorizationConfirmed: false, grantedBy: "owner", evidence: "" })).rejects.toThrow(/Unauthorized/);
    const enrolled = await core.enrollVoice(projectId, { assetId: source.id, name: "Mine", languages: ["en", "es"], authorizationConfirmed: true, grantedBy: "owner", evidence: "recorded consent", scope: "project" }); expect(enrolled.profile.status).toBe("preview"); expect("providerVoiceId" in enrolled.profile).toBe(false); const preview = await core.previewVoice(projectId, { voiceProfileId: enrolled.profile.id, text: "Review me", language: "en" }); expect(preview.requiresApproval).toBe(true); const active = await core.approveVoice(projectId, enrolled.profile.id); expect(active.status).toBe("active");
    const first = await core.generateSpeech(projectId, { voiceProfileId: active.id, text: "forty", language: "en" }); const cached = await core.generateSpeech(projectId, { voiceProfileId: active.id, text: "forty", language: "en" }); expect(cached.id).toBe(first.id); expect(first.generated).toBe(true); expect(first.voiceProfileId).toBe(active.id);
    expect(core.fitSpeech(secondsToUs(4.9), secondsToUs(3.2)).action).toBe("ASK_USER"); expect(core.fitSpeech(secondsToUs(3.5), secondsToUs(3.2)).action).toBe("ADJUST_RATE");
    const replacement = await core.replaceSpeech(projectId, { startUs: 0, endUs: secondsToUs(1), replacementText: "forty", voiceProfileId: active.id, language: "en", mode: "audio" }); expect(replacement.version.version).toBe(2); expect((await store.readTimeline(projectId)).tracks.some((track) => track.type === "tts_replacement")).toBe(true);
    const dubbing = await core.generateDubbing(projectId, { language: "es", segments: [{ sourceSegmentId: transcript.segments[0]!.id, translatedText: "cuarenta", voiceProfileId: active.id }] }); expect(dubbing.version.version).toBe(3); const dubbedTimeline = await store.readTimeline(projectId); expect(dubbedTimeline.tracks.some((track) => track.type === "dubbing")).toBe(true); expect(dubbedTimeline.tracks.some((track) => track.id === "dubbing-captions-es")).toBe(true);
    const designed = await core.designVoice(projectId, { description: "calm rational documentary voice", language: "zh", sampleText: "这是合成声音" }); expect(designed.profile.type).toBe("designed");
    const deletion = await core.deleteVoice(projectId, active.id); expect(deletion.cachesInvalidated).toBe(true); await expect(core.generateSpeech(projectId, { voiceProfileId: active.id, text: "blocked", language: "en" })).rejects.toThrow(/not active/);
  });

  it("exposes an authenticated network API over the same core", async () => {
    const { core, projectId } = await readyCore(); const server = createServer(createApiHandler(core, "test-token")); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("No test address"); const base = `http://127.0.0.1:${address.port}`;
    try { expect((await fetch(`${base}/v1/projects`)).status).toBe(401); const response = await fetch(`${base}/v1/projects/${projectId}`, { headers: { authorization: "Bearer test-token" } }); expect(response.status).toBe(200); expect((await response.json() as { project: { id: string } }).project.id).toBe(projectId); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("propagates cancellation and classifies transient and permanent voice job failures", async () => {
    class ControlledVoice extends FakeVoiceProvider {
      mode: "delay" | "transient" | "permanent" = "delay"; calls = 0;
      override async synthesize(input: { text: string; voiceId: string; language: string; speed?: number }, context?: OperationContext) { this.calls += 1; if (this.mode === "transient" && this.calls < 2) throw new Error("provider timeout 503"); if (this.mode === "permanent") throw new Error("license denied permanently"); if (this.mode === "delay") await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 5_000); context?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled by signal")); }, { once: true }); }); return super.synthesize(input); }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-voice-jobs-")); roots.push(root); const store = new ProjectStore(root); const voice = new ControlledVoice(); const core = new VideoAgentCore(store, { asr: new FakeASRProvider(), tts: voice, voice, planner: new FakeLLMProvider(), renderer: new FakeRenderer() }, { maxUploadBytes: 1_000_000, maxConcurrentJobs: 1, jobMaxAttempts: 2, baseRetryMs: 1 }); const { project } = await core.createProject("Voice jobs"); const profile = { id: "active-voice", type: "designed" as const, provider: voice.id, providerVoiceId: "voice", model: voice.model, name: "Active", languages: ["en"], cloning: false, status: "active" as const, referenceAssetIds: [], authorizationStatus: "not_required" as const, createdAt: new Date().toISOString(), usageRestrictions: [], providerMetadata: {} }; await store.writeVoiceProfile(project.id, profile);
    const wait = async (id: string) => { for (let i = 0; i < 500; i += 1) { const job = await core.jobStatus(project.id, id); if (["succeeded", "failed", "cancelled"].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("job wait timeout"); };
    const cancelled = await core.enqueueJob(project.id, "voice-preview", { voiceProfileId: profile.id, text: "cancel", language: "en" }); for (let i = 0; i < 50 && (await core.jobStatus(project.id, cancelled.id)).status !== "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); await core.cancelJob(project.id, cancelled.id); expect((await wait(cancelled.id)).status).toBe("cancelled");
    voice.mode = "transient"; voice.calls = 0; const retried = await core.enqueueJob(project.id, "voice-preview", { voiceProfileId: profile.id, text: "retry", language: "en" }); const retriedDone = await wait(retried.id); expect(retriedDone.status).toBe("succeeded"); expect(retriedDone.retryHistory).toHaveLength(1);
    voice.mode = "permanent"; const failed = await core.enqueueJob(project.id, "voice-preview", { voiceProfileId: profile.id, text: "fail", language: "en" }); const failedDone = await wait(failed.id); expect(failedDone.status).toBe("failed"); expect(failedDone.failureClass).toBe("permanent"); await core.jobs.shutdown(true);
  });
});
