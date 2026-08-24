import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ProjectStore, type Job } from "../packages/core/src/index.js";
import { DurableJobQueue } from "../packages/jobs/src/index.js";
import { OpenAILLMProvider } from "../packages/providers/src/index.js";
import type { HttpAdapter } from "../packages/platform/src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function waitFor(store: ProjectStore, projectId: string, jobId: string, statuses: Job["status"][]) {
  for (let index = 0; index < 200; index += 1) {
    const job = await store.readJob(projectId, jobId);
    if (statuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Job did not settle");
}

class CountingStore extends ProjectStore {
  listJobsCalls = 0;
  override async listJobs(projectId: string) { this.listJobsCalls += 1; return super.listJobs(projectId); }
}

function successfulHttp(onRequest?: () => void): HttpAdapter {
  return {
    async request() {
      onRequest?.();
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ output_text: '{"ok":true}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })) };
    },
  };
}

describe("runtime hardening", () => {
  it("builds the durable scheduler index once instead of rescanning every pump", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-indexed-jobs-")); roots.push(root);
    const store = new CountingStore(root); const { project } = await store.create("Indexed jobs");
    const queue = new DurableJobQueue(store, { concurrency: 1, maxAttempts: 1, baseRetryMs: 1 });
    queue.register("asr", async () => ({ ok: true }));
    await queue.recover();
    expect(store.listJobsCalls).toBe(1);
    for (let index = 0; index < 4; index += 1) {
      const job = await queue.enqueue(project.id, "asr", { index }, `asr-${index}`);
      await waitFor(store, project.id, job.id, ["succeeded"]);
    }
    expect(store.listJobsCalls).toBe(1);
    await queue.shutdown();
  });

  it("persists terminal cancellation before a handler notices AbortSignal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-terminal-cancel-")); roots.push(root);
    const store = new ProjectStore(root); const { project } = await store.create("Cancellation");
    const queue = new DurableJobQueue(store, { concurrency: 1, maxAttempts: 1, baseRetryMs: 1 });
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    queue.register("tts", async () => { started?.(); await new Promise<void>((resolve) => { release = resolve; }); return { ok: true }; });
    const job = await queue.enqueue(project.id, "tts", {});
    await didStart;
    const cancelled = await queue.cancel(project.id, job.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await store.readJob(project.id, job.id)).status).toBe("cancelled");
    release?.();
    await queue.shutdown();
    expect((await store.readJob(project.id, job.id)).status).toBe("cancelled");
  });

  it("bounds unconsumed planner call metadata", async () => {
    const provider = new OpenAILLMProvider("test-model", "test-key", "https://example.invalid/v1", 1_000, successfulHttp());
    for (let index = 0; index < 40; index += 1) {
      await provider.generateStructured({ requestId: `req-${index}`, operation: "strategy", instructions: "test", input: "test", schemaName: "result", schema: z.object({ ok: z.boolean() }), jsonSchema: { type: "object" } });
    }
    let retained = 0;
    while (provider.takeLastCall()) retained += 1;
    expect(retained).toBe(32);
  });

  it("does not start an HTTP request when planner cancellation already happened", async () => {
    let requests = 0;
    const provider = new OpenAILLMProvider("test-model", "test-key", "https://example.invalid/v1", 1_000, successfulHttp(() => { requests += 1; }));
    const controller = new AbortController(); controller.abort(new Error("cancel first"));
    await expect(provider.generateStructured({ requestId: "cancelled", operation: "strategy", instructions: "test", input: "test", schemaName: "result", schema: z.object({ ok: z.boolean() }), jsonSchema: { type: "object" }, signal: controller.signal })).rejects.toThrow(/cancel first/);
    expect(requests).toBe(0);
  });
});
