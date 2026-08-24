import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { providerConfigSchema, type Job } from "../packages/core/src/schemas.js";
import { createMobileHost } from "../packages/mobile/src/composition.js";
import type { NativeRenderSpec, NativeVideoHostBridge } from "../packages/mobile/src/native-bridge.js";
import { buildMobileContextPack } from "../packages/mobile/src/privacy.js";
import { NativeMobileRenderer } from "../packages/mobile/src/renderer.js";
import type { LogicalUri } from "../packages/platform/src/contracts.js";

class ContractBridge implements NativeVideoHostBridge {
  files = new Map<string, Uint8Array>(); secrets = new Map<string, string>(); scheduled = new Map<string, { id: string; kind: string }>();
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
  async probe() { return { durationUs: 60_000_000, sizeBytes: 4, width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 }, videoCodec: "h264", audioCodec: "aac" }; }
  async render(spec: NativeRenderSpec) { this.files.set(spec.outputUri, new Uint8Array([0, 0, 0, 24])); return { outputUri: spec.outputUri, durationUs: 1_000_000, warnings: [] }; }
  async cancelRender() {}
  async rendererCapabilities() { return { trim: true, concat: true, crop: true, scale: true, preserveAudio: true, speed: false, captionBurnIn: false as const, audioDucking: false, overlay: false, backgroundExport: false }; }
  async secureSet(key: string, value: string) { this.secrets.set(key, value); }
  async secureGet(key: string) { return this.secrets.get(key); }
  async secureDelete(key: string) { this.secrets.delete(key); }
  async http() { return { status: 200, headers: {}, body: [] }; }
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

describe("native mobile host contracts", () => {
  it("persists projects and recovers a running durable job after restart", async () => {
    const bridge = new ContractBridge(); const first = await createMobileHost(bridge); const { project } = await first.facade.createProject("Restart proof");
    const now = new Date().toISOString(); const running: Job = { schemaVersion: 1, id: randomUUID(), type: "preview-render", projectId: project.id, status: "running", progress: 0.4, phase: "native-render", input: {}, attempt: 1, maxAttempts: 3, retryHistory: [], cancellationRequested: false, createdAt: now, updatedAt: now };
    await first.repository.writeJob(project.id, running); const second = await createMobileHost(bridge); expect((await second.facade.status(project.id)).project.id).toBe(project.id); const recovered = await second.facade.listJobs(project.id); expect(recovered[0]?.status).toBe("queued"); expect(recovered[0]?.phase).toBe("recovered");
  });

  it("stores only credentialRef in durable JSON", async () => {
    const bridge = new ContractBridge(); const host = await createMobileHost(bridge); const config = providerConfigSchema.parse({ schemaVersion: 1, id: "openai-mobile", kind: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "test-model", credentialRef: "credential.openai-mobile", authMode: "DIRECT_BYOK", reasoning: "off" }); await host.providerSettings.save(config, "sk-test-never-in-json"); const durable = [...bridge.files.values()].map((value) => new TextDecoder().decode(value)).join("\n"); expect(durable).toContain("credential.openai-mobile"); expect(durable).not.toContain("sk-test-never-in-json"); expect(bridge.secrets.get("credential.openai-mobile")).toBe("sk-test-never-in-json");
  });

  it("builds text-only ContextPack evidence with zero remote media bytes", async () => {
    const bridge = new ContractBridge(); const host = await createMobileHost(bridge); const config = providerConfigSchema.parse({ schemaVersion: 1, id: "provider-1", kind: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "test-model", credentialRef: "credential.provider-1", authMode: "DIRECT_BYOK", reasoning: "off" }); const result = await buildMobileContextPack(host.profile.primitives, { projectId: "project-1", provider: config, approvedAt: new Date().toISOString() }); expect(result.evidence.remoteMediaBytes).toBe(0); expect(result.evidence.frames).toBe(0); expect(result.pack.policy.includeRawMedia).toBe(false);
  });

  it("rejects timeline operations missing from the renderer capability matrix", async () => {
    const bridge = new ContractBridge(); const renderer = new NativeMobileRenderer(bridge, "ios"); await expect(renderer.renderPreview({ projectId: "project-1", timeline: { schemaVersion: 1, id: "timeline-1", projectId: "project-1", frameRate: { numerator: 30, denominator: 1 }, width: 1080, height: 1920, durationUs: 1_000_000, tracks: [{ id: "video", type: "video", name: "Video", muted: false, gainDb: 0, clips: [{ id: "clip-1", type: "video", assetId: "asset-1", sourceInUs: 0, sourceOutUs: 1_000_000, timelineInUs: 0, timelineOutUs: 500_000, speed: 2, gainDb: 0, transcriptWordIds: [], metadata: {} }] }], updatedAt: new Date().toISOString() }, outputPath: "project://project-1/previews/v1.mp4", resolveAssetPath: () => "project://project-1/assets/a.mp4" })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});
