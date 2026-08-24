import { describe, expect, it } from "vitest";
import { providerConfigSchema, remoteContextPolicySchema } from "../packages/core/src/index.js";
import { ProviderRegistry } from "../packages/providers/src/index.js";
import { MemorySecureStorage } from "../packages/platform/src/index.js";
import { MobileHostRuntime } from "../packages/runtime/src/index.js";
import { DurableJobQueue } from "../packages/jobs/src/index.js";

describe("mobile host runtime", () => {
  it("runs a zero app-server editing flow with logical assets", async () => {
    const host = new MobileHostRuntime(); const result = await host.runZeroServerDemo();
    expect(result.backendRequests).toBe(0); expect(result.project.activeVersion).toBe(1); expect(result.version.timeline.tracks.some((track) => track.type === "video")).toBe(true);
    expect(result.project.assets[0]?.ref?.uri).toMatch(/^project:\/\//u); expect(await host.profile.filesystem.exists(result.previewUri)).toBe(true);
    await host.queue.shutdown(true);
  });

  it("keeps credentials out of provider config and discovers models through the portable HTTP boundary", async () => {
    const secrets = new MemorySecureStorage(); await secrets.set("credential://openai/personal", "secret-value");
    const registry = new ProviderRegistry({ request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: [{ id: "gpt-test" }] })) }) }, secrets);
    const config = registry.set(providerConfigSchema.parse({ schemaVersion: 1, id: "personal", kind: "openai", displayName: "Personal OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-test", credentialRef: "credential://openai/personal", authMode: "DIRECT_BYOK", reasoning: "high", modelDiscovery: "api", enabled: true, metadata: {} }));
    expect(JSON.stringify(config)).not.toContain("secret-value"); expect(await registry.credential(config)).toBe("secret-value"); expect((await registry.discoverModels(config.id))[0]?.id).toBe("gpt-test");
  });

  it("makes raw media and local URI disclosure impossible in remote text policy", () => {
    const policy = remoteContextPolicySchema.parse({ mode: "text-only" });
    expect(policy.includeRawMedia).toBe(false); expect(policy.includeLocalUris).toBe(false); expect(policy.requireApproval).toBe(true);
  });

  it("recovers a mobile-host running job from durable state after restart", async () => {
    const host = new MobileHostRuntime(); const project = await host.createProject("Recovery"); const now = new Date().toISOString();
    await host.jobStore.writeJob(project.id, { schemaVersion: 1, id: "mobile-recovery-job", type: "llm-strategy", projectId: project.id, status: "running", progress: 0.4, phase: "calling-provider", input: {}, attempt: 1, maxAttempts: 2, retryHistory: [], cancellationRequested: false, createdAt: now, startedAt: now, updatedAt: now });
    const restarted = new DurableJobQueue(host.jobStore, { concurrency: 1, maxAttempts: 2, baseRetryMs: 1 }, host.profile.primitives.clock, host.profile.primitives.ids, host.profile.background); restarted.register("llm-strategy", async () => ({ recovered: true })); await restarted.recover();
    for (let index = 0; index < 100; index += 1) { const job = await restarted.status(project.id, "mobile-recovery-job"); if (job.status === "succeeded") break; await host.profile.primitives.clock.sleep(5); }
    const done = await restarted.status(project.id, "mobile-recovery-job"); expect(done.status).toBe("succeeded"); expect(done.retryHistory[0]?.error).toMatch(/restarted/iu); await restarted.shutdown(true); await host.queue.shutdown(true);
  });
});
