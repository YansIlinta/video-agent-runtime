import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore, type Job } from "../packages/core/src/index.js";
import { DurableJobQueue } from "../packages/jobs/src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function waitFor(store: ProjectStore, projectId: string, jobId: string, statuses: Job["status"][]) { for (let index = 0; index < 100; index += 1) { const job = await store.readJob(projectId, jobId); if (statuses.includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Job did not settle"); }
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-jobs-")); roots.push(root); const store = new ProjectStore(root); const { project } = await store.create("Jobs"); return { store, project }; }

describe("durable job queue", () => {
  it("persists progress, retries only a transient failure, and succeeds once", async () => {
    const { store, project } = await setup(); const queue = new DurableJobQueue(store, { concurrency: 1, maxAttempts: 2, baseRetryMs: 1 }); let calls = 0;
    queue.register("asr", async (_job, context) => { calls += 1; await context.progress(0.5, "transcribing", "half"); if (calls === 1) throw new Error("provider timed out"); return { transcriptId: "t" }; });
    const job = await queue.enqueue(project.id, "asr", { assetId: "a" }, "same");
    expect((await queue.enqueue(project.id, "asr", { assetId: "a" }, "same")).id).toBe(job.id);
    const done = await waitFor(store, project.id, job.id, ["succeeded"]);
    expect(done).toMatchObject({ status: "succeeded", attempt: 2, progress: 1 });
    expect(done.retryHistory).toHaveLength(1);
    await queue.shutdown();
  });

  it("propagates cancellation to an active handler", async () => {
    const { store, project } = await setup(); const queue = new DurableJobQueue(store, { concurrency: 1, maxAttempts: 1, baseRetryMs: 1 });
    queue.register("preview-render", async (_job, context) => new Promise((_resolve, reject) => { if (context.signal.aborted) reject(new Error("cancelled")); else context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }));
    const job = await queue.enqueue(project.id, "preview-render", {}); await waitFor(store, project.id, job.id, ["running"]); await queue.cancel(project.id, job.id);
    expect((await waitFor(store, project.id, job.id, ["cancelled"])).failureClass).toBe("cancelled");
    await queue.shutdown();
  });

  it("requeues interrupted running jobs after restart", async () => {
    const { store, project } = await setup(); const now = new Date().toISOString();
    const interrupted: Job = { schemaVersion: 1, id: "interrupted", type: "visual-analysis", projectId: project.id, status: "running", progress: 0.3, phase: "frames", input: {}, attempt: 1, maxAttempts: 2, retryHistory: [], cancellationRequested: false, createdAt: now, startedAt: now, updatedAt: now };
    await store.writeJob(project.id, interrupted);
    const queue = new DurableJobQueue(store, { concurrency: 1, maxAttempts: 2, baseRetryMs: 1 }); queue.register("visual-analysis", async () => ({ ok: true })); await queue.recover();
    const done = await waitFor(store, project.id, interrupted.id, ["succeeded"]);
    expect(done.retryHistory[0]).toMatchObject({ failureClass: "transient" });
    await queue.shutdown();
  });
});
