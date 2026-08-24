import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { providerConfigSchema, timelineSchema, type Asset, type Job, type Timeline } from "../packages/core/src/schemas.js";
import { fromBase64, toBase64 } from "../packages/mobile/src/base64.js";
import { createMobileHost } from "../packages/mobile/src/composition.js";
import type { NativeRenderSpec, NativeVideoHostBridge } from "../packages/mobile/src/native-bridge.js";
import { buildMobileContextPack } from "../packages/mobile/src/privacy.js";
import { outputSize, sliceTimelineToRange } from "../packages/mobile/src/render-plan.js";
import { NativeMobileRenderer } from "../packages/mobile/src/renderer.js";
import { createMobilePreviewSelfCheck } from "../packages/mobile/src/self-check.js";
import type { LogicalUri } from "../packages/platform/src/contracts.js";

class ContractBridge implements NativeVideoHostBridge {
  files = new Map<string, Uint8Array>(); secrets = new Map<string, string>(); scheduled = new Map<string, { id: string; kind: string }>();
  renders: NativeRenderSpec[] = [];
  httpRequests: Array<{ bodyBase64?: string }> = [];
  probeResult: Asset["metadata"] = { durationUs: 1_000_000, sizeBytes: 4, width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" };
  capabilityOverride?: Partial<Awaited<ReturnType<NativeVideoHostBridge["rendererCapabilities"]>>>;
  async platform() { return "ios" as const; }
  async read(uri: LogicalUri) { const value = this.files.get(uri); if (!value) throw new Error(`NOT_FOUND ${uri}`); return [...value]; }
  async write(uri: LogicalUri, bytes: number[], _atomic: boolean, createOnly: boolean) { if (createOnly && this.files.has(uri)) throw new Error("exists"); this.files.set(uri, Uint8Array.from(bytes)); }
  async remove(uri: LogicalUri) { this.files.delete(uri); }
  async exists(uri: LogicalUri) { return this.files.has(uri); }
  async stat(uri: LogicalUri) { const value = this.files.get(uri); if (!value) throw new Error("NOT_FOUND"); return { sizeBytes: value.byteLength, kind: "file" as const, modifiedAt: new Date(0).toISOString() }; }
  async list(uri: LogicalUri) { return [...this.files.keys()].filter((key) => key.startsWith(uri)) as LogicalUri[]; }
  async copy(source: string, destination: LogicalUri) { const value = this.files.get(source); if (!value) throw new Error("NOT_FOUND source"); this.files.set(destination, value.slice()); }
  async diskFreeBytes() { return 10_000_000_000; }
  async pickVideo() { return { sourceUri: "import://picked.mp4", displayName: "picked.mp4", mediaType: "video/mp4", sizeBytes: 4 }; }
  async probe() { return this.probeResult; }
  async render(spec: NativeRenderSpec) { this.renders.push(spec); this.files.set(spec.outputUri, new Uint8Array([0, 0, 0, 24])); return { outputUri: spec.outputUri, durationUs: 1_000_000, warnings: [] }; }
  async cancelRender() {}
  async rendererCapabilities() { return { trim: true, concat: true, crop: true, scale: true, preserveAudio: true, speed: false, captionBurnIn: false as false | "partial" | true, audioDucking: false, overlay: false, backgroundExport: false, ...this.capabilityOverride }; }
  async secureSet(key: string, value: string) { this.secrets.set(key, value); }
  async secureGet(key: string) { return this.secrets.get(key); }
  async secureDelete(key: string) { this.secrets.delete(key); }
  async http(request: { bodyBase64?: string }) { this.httpRequests.push(request); return { status: 200, headers: {}, bodyBase64: toBase64(new TextEncoder().encode("{}")) }; }
  async scheduleBackground(task: { id: string; kind: string }) { this.scheduled.set(task.id, task); }
  async cancelBackground(id: string) { this.scheduled.delete(id); }
  async pendingBackground() { return [...this.scheduled.values()]; }
  async backgroundBudgetMs() { return 25_000; }
  async permissionStatus() { return "granted" as const; }
  async requestPermission() { return "granted" as const; }
  async resourceBudget() { return { maxWorkingSetBytes: 512_000_000, maxConcurrentMediaJobs: 1, previewMaxWidth: 1280, previewMaxDurationUs: 120_000_000, thermalState: "nominal" as const, powerState: "battery" as const }; }
  async sha256(data: number[] | string) { return createHash("sha256").update(typeof data === "string" ? data : Uint8Array.from(data)).digest("hex"); }
  async sha256File(uri: LogicalUri) { return createHash("sha256").update(this.files.get(uri) ?? new Uint8Array()).digest("hex"); }
  randomBytes(length: number) { return [...randomBytes(length)]; }
  createId() { return randomUUID(); }
}

function portraitTimeline(clips: Array<{ id: string; sourceInUs: number; sourceOutUs: number; timelineInUs: number; timelineOutUs: number; speed?: number }>, extraTracks: unknown[] = []): Timeline {
  return timelineSchema.parse({
    schemaVersion: 1, id: "timeline-1", projectId: "project-1", frameRate: { numerator: 30, denominator: 1 },
    width: 1080, height: 1920, durationUs: 10_000_000, updatedAt: new Date().toISOString(),
    tracks: [{ id: "video", type: "video", name: "Video", muted: false, gainDb: 0, clips: clips.map((clip) => ({ ...clip, type: "video", assetId: "asset-1", speed: clip.speed ?? 1, gainDb: 0, transcriptWordIds: [], metadata: {} })) }, ...extraTracks],
  });
}

const renderRequest = (timeline: Timeline, range?: { startUs: number; endUs: number }) => ({
  projectId: "project-1", timeline, outputPath: "project://project-1/previews/v1.mp4",
  resolveAssetPath: () => "project://project-1/assets/a.mp4", ...(range ? { range } : {}),
});

const renderer = (bridge: ContractBridge, previewMaxWidth = 1280) => new NativeMobileRenderer(bridge, { platform: "ios", previewMaxWidth, createId: () => "job" });

describe("native mobile host contracts", () => {
  it("persists projects and recovers a running durable job after restart", async () => {
    const bridge = new ContractBridge(); const first = await createMobileHost(bridge); const { project } = await first.facade.createProject("Restart proof");
    const now = new Date().toISOString(); const running: Job = { schemaVersion: 1, id: randomUUID(), type: "preview-render", projectId: project.id, status: "running", progress: 0.4, phase: "native-render", input: {}, attempt: 1, maxAttempts: 3, retryHistory: [], cancellationRequested: false, createdAt: now, updatedAt: now };
    await first.repository.writeJob(project.id, running); const second = await createMobileHost(bridge); expect((await second.facade.status(project.id)).project.id).toBe(project.id); const recovered = await second.facade.listJobs(project.id); expect(recovered[0]?.status).toBe("queued"); expect(recovered[0]?.phase).toBe("recovered");
  });

  it("stores only credentialRef in durable JSON", async () => {
    const bridge = new ContractBridge(); const host = await createMobileHost(bridge); const config = providerConfigSchema.parse({ schemaVersion: 1, id: "openai-mobile", kind: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "test-model", credentialRef: "credential.openai-mobile", authMode: "DIRECT_BYOK", reasoning: "off" }); await host.providerSettings.save(config, "sk-test-never-in-json"); const durable = [...bridge.files.values()].map((value) => new TextDecoder().decode(value)).join("\n"); expect(durable).toContain("credential.openai-mobile"); expect(durable).not.toContain("sk-test-never-in-json"); expect(bridge.secrets.get("credential.openai-mobile")).toBe("sk-test-never-in-json");
  });

  it("builds text-only ContextPack evidence and refuses modes this host cannot honour", async () => {
    const bridge = new ContractBridge(); const host = await createMobileHost(bridge); const config = providerConfigSchema.parse({ schemaVersion: 1, id: "provider-1", kind: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "test-model", credentialRef: "credential.provider-1", authMode: "DIRECT_BYOK", reasoning: "off" });
    const result = await buildMobileContextPack(host.profile.primitives, { projectId: "project-1", provider: config, approvedAt: new Date().toISOString() });
    expect(result.evidence.remoteMediaBytes).toBe(0); expect(result.evidence.frames).toBe(0); expect(result.pack.policy.includeRawMedia).toBe(false);
    // The policy is no longer silently rewritten, so an unsupported request must be rejected.
    await expect(buildMobileContextPack(host.profile.primitives, { projectId: "project-1", provider: config, approvedAt: new Date().toISOString(), policy: { mode: "allow-remote-media", includeRawMedia: true } })).rejects.toThrow(/not implemented on this host/u);
    await expect(buildMobileContextPack(host.profile.primitives, { projectId: "project-1", provider: config })).rejects.toThrow(/requires explicit approval/u);
  });

  it("rejects timeline operations missing from the renderer capability matrix", async () => {
    const bridge = new ContractBridge();
    await expect(renderer(bridge).renderPreview(renderRequest(portraitTimeline([{ id: "clip-1", sourceInUs: 0, sourceOutUs: 1_000_000, timelineInUs: 0, timelineOutUs: 500_000, speed: 2 }])))).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("does not let a partial caption capability pass as full support", async () => {
    const captionTrack = { id: "captions", type: "caption", name: "Captions", muted: false, gainDb: 0, clips: [{ id: "cap-1", type: "caption", text: "hello", sourceInUs: 0, sourceOutUs: 1_000_000, timelineInUs: 0, timelineOutUs: 1_000_000, speed: 1, gainDb: 0, transcriptWordIds: [], metadata: {} }] };
    const timeline = portraitTimeline([{ id: "clip-1", sourceInUs: 0, sourceOutUs: 1_000_000, timelineInUs: 0, timelineOutUs: 1_000_000 }], [captionTrack]);
    const rejecting = new ContractBridge();
    await expect(renderer(rejecting).renderPreview(renderRequest(timeline))).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    const partial = new ContractBridge(); partial.capabilityOverride = { captionBurnIn: "partial" };
    const result = await renderer(partial).renderPreview(renderRequest(timeline));
    expect(result.warnings.some((warning) => /partial caption burn-in/u.test(warning))).toBe(true);
  });

  it("renders the timeline geometry instead of a hardcoded size", async () => {
    const bridge = new ContractBridge(); const timeline = portraitTimeline([{ id: "clip-1", sourceInUs: 0, sourceOutUs: 10_000_000, timelineInUs: 0, timelineOutUs: 10_000_000 }]);
    await renderer(bridge).renderFinal(renderRequest(timeline));
    expect(bridge.renders.at(-1)).toMatchObject({ mode: "final", outputWidth: 1080, outputHeight: 1920 });
    await renderer(bridge, 720).renderPreview(renderRequest(timeline));
    // Preview scales down but keeps the portrait aspect ratio, and stays even for the encoder.
    expect(bridge.renders.at(-1)).toMatchObject({ mode: "preview", outputWidth: 720, outputHeight: 1280 });
  });

  it("sends only the requested range to the native renderer", async () => {
    const bridge = new ContractBridge();
    const timeline = portraitTimeline([
      { id: "clip-1", sourceInUs: 1_000_000, sourceOutUs: 5_000_000, timelineInUs: 0, timelineOutUs: 4_000_000 },
      { id: "clip-2", sourceInUs: 0, sourceOutUs: 6_000_000, timelineInUs: 4_000_000, timelineOutUs: 10_000_000 },
    ]);
    await renderer(bridge).renderPreview(renderRequest(timeline, { startUs: 3_000_000, endUs: 6_000_000 }));
    const sent = JSON.parse(bridge.renders.at(-1)!.timelineJson) as Timeline;
    expect(sent.durationUs).toBe(3_000_000);
    const clips = sent.tracks[0]!.clips;
    expect(clips).toHaveLength(2);
    // Head of clip-1 is trimmed and the whole thing rebases to zero.
    expect(clips[0]).toMatchObject({ id: "clip-1", timelineInUs: 0, timelineOutUs: 1_000_000, sourceInUs: 4_000_000, sourceOutUs: 5_000_000 });
    expect(clips[1]).toMatchObject({ id: "clip-2", timelineInUs: 1_000_000, timelineOutUs: 3_000_000, sourceInUs: 0, sourceOutUs: 2_000_000 });
  });

  it("rejects a range that selects no video", async () => {
    const bridge = new ContractBridge(); const timeline = portraitTimeline([{ id: "clip-1", sourceInUs: 0, sourceOutUs: 2_000_000, timelineInUs: 0, timelineOutUs: 2_000_000 }]);
    await expect(renderer(bridge).renderPreview(renderRequest(timeline, { startUs: 8_000_000, endUs: 9_000_000 }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("self-checks a rendered preview against what was actually written", async () => {
    const bridge = new ContractBridge(); const check = createMobilePreviewSelfCheck(bridge); const timeline = portraitTimeline([{ id: "clip-1", sourceInUs: 0, sourceOutUs: 10_000_000, timelineInUs: 0, timelineOutUs: 10_000_000 }]);
    expect(await check("project://project-1/previews/missing.mp4", timeline)).toMatchObject({ passed: false, warnings: ["Preview file was not written"] });
    bridge.files.set("project://project-1/previews/v1.mp4", new Uint8Array([1, 2, 3, 4]));
    bridge.probeResult = { durationUs: 10_000_000, sizeBytes: 4, videoCodec: "h264", audioCodec: "aac" };
    expect(await check("project://project-1/previews/v1.mp4", timeline)).toEqual({ passed: true, warnings: [] });
    // A ranged preview is judged against the rendered duration, not the whole timeline.
    bridge.probeResult = { durationUs: 3_000_000, sizeBytes: 4, videoCodec: "h264", audioCodec: "aac" };
    expect(await check("project://project-1/previews/v1.mp4", timeline, 3_000_000)).toEqual({ passed: true, warnings: [] });
    const drifted = await check("project://project-1/previews/v1.mp4", timeline);
    expect(drifted.passed).toBe(false);
    bridge.probeResult = { durationUs: 10_000_000, sizeBytes: 4 };
    const silent = await check("project://project-1/previews/v1.mp4", timeline);
    expect(silent.warnings).toContain("Preview has no video stream");
    expect(silent.warnings).toContain("Preview has no audio stream");
  });

  it("carries binary HTTP bodies without corrupting them", async () => {
    const bridge = new ContractBridge(); const host = await createMobileHost(bridge);
    const payload = Uint8Array.from([0, 255, 128, 10, 13, 0x89, 0x50, 0x4e, 0x47]);
    const response = await host.profile.http.request({ method: "POST", url: "https://api.openai.com/v1/audio/transcriptions", body: payload });
    expect(fromBase64(bridge.httpRequests.at(-1)!.bodyBase64!)).toEqual(payload);
    expect(new TextDecoder().decode(response.body)).toBe("{}");
  });

  it("round-trips arbitrary bytes through the portable base64 codec", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255, 1024]) {
      const bytes = Uint8Array.from(randomBytes(length));
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
    expect(toBase64(new TextEncoder().encode("hi"))).toBe("aGk=");
    expect(new TextDecoder().decode(fromBase64("aGVsbG8="))).toBe("hello");
  });

  it("refuses to invent a transcript on a host with no ASR", async () => {
    const bridge = new ContractBridge(); const host = await createMobileHost(bridge);
    expect(host.core.providers.asr.id).toBe("mobile-asr-unavailable");
    await expect(host.core.providers.asr.transcribe("project://project-1/assets/a.mp4")).rejects.toThrow(/not implemented on this host/u);
  });
});

describe("mobile render plan", () => {
  it("keeps final output at timeline geometry and only scales previews down", () => {
    const timeline = portraitTimeline([{ id: "clip-1", sourceInUs: 0, sourceOutUs: 1_000_000, timelineInUs: 0, timelineOutUs: 1_000_000 }]);
    expect(outputSize(timeline, "final", 720)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(timeline, "preview", 1280)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(timeline, "preview", 540)).toEqual({ width: 540, height: 960 });
  });

  it("produces even dimensions for odd timelines", () => {
    const odd = timelineSchema.parse({ schemaVersion: 1, id: "t", projectId: "p", frameRate: { numerator: 30, denominator: 1 }, width: 1081, height: 1921, durationUs: 0, tracks: [], updatedAt: new Date().toISOString() });
    const size = outputSize(odd, "final", 1280);
    expect(size.width % 2).toBe(0); expect(size.height % 2).toBe(0);
  });

  it("drops clips outside the range and clamps a range wider than the timeline", () => {
    const timeline = portraitTimeline([
      { id: "a", sourceInUs: 0, sourceOutUs: 2_000_000, timelineInUs: 0, timelineOutUs: 2_000_000 },
      { id: "b", sourceInUs: 0, sourceOutUs: 2_000_000, timelineInUs: 8_000_000, timelineOutUs: 10_000_000 },
    ]);
    expect(sliceTimelineToRange(timeline, { startUs: 0, endUs: 3_000_000 }).tracks[0]!.clips.map((clip) => clip.id)).toEqual(["a"]);
    const clamped = sliceTimelineToRange(timeline, { startUs: -5_000_000, endUs: 10_000_000 });
    expect(clamped.durationUs).toBe(10_000_000);
    expect(clamped.tracks[0]!.clips).toHaveLength(2);
  });
});
