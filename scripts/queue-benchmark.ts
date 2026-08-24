import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../packages/core/src/index.js";
import { DurableJobQueue } from "../packages/jobs/src/index.js";

const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-queue-bench-"));
try {
  const store = new ProjectStore(root); const projects = await Promise.all(Array.from({ length: 5 }, (_, index) => store.create(`Queue ${index}`)));
  const queue = new DurableJobQueue(store, { concurrency: 4, maxAttempts: 1, baseRetryMs: 1 }); queue.register("visual-analysis", async () => ({ ok: true }));
  const started = performance.now(); const jobs = [];
  for (let index = 0; index < 50; index += 1) jobs.push(await queue.enqueue(projects[index % projects.length]!.project.id, "visual-analysis", { index }));
  while (true) { const states = await Promise.all(jobs.map((job) => store.readJob(job.projectId, job.id))); if (states.every((job) => job.status === "succeeded")) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
  const durationMs = performance.now() - started;
  process.stdout.write(`${JSON.stringify({ jobs: jobs.length, projects: projects.length, concurrency: 4, durationMs: Math.round(durationMs), jobsPerSecond: Math.round((jobs.length / durationMs) * 1000 * 10) / 10 }, null, 2)}\n`);
  await queue.shutdown();
} finally { await rm(root, { recursive: true, force: true }); }
