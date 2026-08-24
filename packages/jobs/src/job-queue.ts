import type { FailureClass, Job, JobEvent } from "../../core/src/schemas.js";
import { MemoryBackgroundExecution, SystemClock, WebIdAdapter } from "../../platform/src/portable.js";
import type { BackgroundExecutionAdapter, ClockAdapter, IdAdapter } from "../../platform/src/contracts.js";

export interface JobStore { listProjectIds(): Promise<string[]>; sweepTemporaryFiles(projectId: string): Promise<string[]>; listJobs(projectId: string): Promise<Job[]>; readJob(projectId: string, jobId: string): Promise<Job>; writeJob(projectId: string, job: Job): Promise<void>; writeJobEvent(projectId: string, event: JobEvent): Promise<void> }

export interface JobContext { signal: AbortSignal; progress(value: number, phase: string, message?: string): Promise<void> }
export type JobHandler = (job: Job, context: JobContext) => Promise<unknown>;

export interface JobQueueOptions { concurrency: number; maxAttempts: number; baseRetryMs: number; typeConcurrency?: Partial<Record<Job["type"], number>> }

export function classifyFailure(error: unknown, signal?: AbortSignal): FailureClass {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (signal?.aborted || /abort|cancel/iu.test(message)) return "cancelled";
  if (/invalid|unknown asset|validation|missing|required|out of range/iu.test(message)) return "invalid_input";
  if (/disk full|ENOSPC|quota|resource exhausted/iu.test(message)) return "resource_exhausted";
  if (/timeout|timed out|429|502|503|504|ECONNRESET|EAI_AGAIN/iu.test(message)) return "transient";
  if (/provider|openai|whisper|kokoro/iu.test(message)) return "provider_error";
  return "permanent";
}

function idempotencyMapKey(projectId: string, key: string) { return `${projectId}\u0000${key}`; }

export class DurableJobQueue {
  private readonly handlers = new Map<Job["type"], JobHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeProjects = new Set<string>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly activeTypes = new Map<Job["type"], number>();
  /** Disk is authoritative across restarts; this is only the hot-path scheduler index. */
  private readonly pendingByProject = new Map<string, Job[]>();
  private readonly idempotency = new Map<string, { projectId: string; jobId: string }>();
  private running = 0;
  private pumpScheduled = false;
  private pumping = false;
  private pumpAgain = false;
  private recovered = false;
  private closing = false;
  private pumpPromise: Promise<void> | undefined;
  private recoveryPromise: Promise<void> | undefined;

  constructor(private readonly store: JobStore, private readonly options: JobQueueOptions, private readonly clock: ClockAdapter = new SystemClock(), private readonly ids: IdAdapter = new WebIdAdapter(), private readonly background: BackgroundExecutionAdapter = new MemoryBackgroundExecution()) {}
  private now() { return this.clock.now().toISOString(); }

  register(type: Job["type"], handler: JobHandler): void { this.handlers.set(type, handler); }

  private addPending(job: Job): void {
    if (job.status !== "queued" || job.cancellationRequested) return;
    const queue = this.pendingByProject.get(job.projectId) ?? [];
    if (!queue.some((candidate) => candidate.id === job.id)) {
      queue.push(job);
      queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    this.pendingByProject.set(job.projectId, queue);
  }

  private removePending(projectId: string, jobId: string): void {
    const queue = this.pendingByProject.get(projectId);
    if (!queue) return;
    const next = queue.filter((job) => job.id !== jobId);
    if (next.length === 0) this.pendingByProject.delete(projectId);
    else this.pendingByProject.set(projectId, next);
  }

  private rememberIdempotency(job: Job): void {
    if (!job.idempotencyKey) return;
    if (["queued", "running", "succeeded"].includes(job.status)) this.idempotency.set(idempotencyMapKey(job.projectId, job.idempotencyKey), { projectId: job.projectId, jobId: job.id });
    else this.idempotency.delete(idempotencyMapKey(job.projectId, job.idempotencyKey));
  }

  async enqueue(projectId: string, type: Job["type"], input: unknown, idempotencyKey?: string): Promise<Job> {
    if (!this.recovered) await this.recover();
    if (idempotencyKey) {
      const mapKey = idempotencyMapKey(projectId, idempotencyKey);
      const ref = this.idempotency.get(mapKey);
      if (ref) {
        try {
          const existing = await this.store.readJob(ref.projectId, ref.jobId);
          if (["queued", "running", "succeeded"].includes(existing.status)) return existing;
        } catch { /* stale hot-path entry; durable state wins */ }
        this.idempotency.delete(mapKey);
      }
    }
    const now = this.now();
    const job: Job = { schemaVersion: 1, id: this.ids.create(), type, projectId, status: "queued", progress: 0, phase: "queued", input, ...(idempotencyKey ? { idempotencyKey } : {}), attempt: 0, maxAttempts: this.options.maxAttempts, retryHistory: [], cancellationRequested: false, createdAt: now, updatedAt: now };
    await this.store.writeJob(projectId, job);
    await this.event(job, "job.queued", "queued", 0);
    await this.background.schedule({ id: job.id, kind: job.type, requiresNetwork: job.type.startsWith("llm-") });
    this.addPending(job);
    this.rememberIdempotency(job);
    this.schedulePump();
    return job;
  }

  async status(projectId: string, jobId: string): Promise<Job> { return this.store.readJob(projectId, jobId); }
  async list(projectId: string): Promise<Job[]> { return this.store.listJobs(projectId); }

  async cancel(projectId: string, jobId: string): Promise<Job> {
    const job = await this.store.readJob(projectId, jobId);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    const cancelled: Job = { ...job, status: "cancelled", cancellationRequested: true, phase: "cancelled", error: "Cancelled by user", failureClass: "cancelled", finishedAt: this.now(), updatedAt: this.now() };
    this.removePending(projectId, job.id);
    this.rememberIdempotency(cancelled);
    await this.background.cancel(job.id);
    // Persist terminal cancellation before signalling provider/native code. A provider that attaches
    // its abort listener late can no longer leave the durable job stuck in running state.
    await this.store.writeJob(projectId, cancelled);
    await this.event(cancelled, "job.cancelled", "cancelled", cancelled.progress, "Cancelled by user");
    this.controllers.get(job.id)?.abort(new Error("Job cancelled by user"));
    this.schedulePump();
    return cancelled;
  }

  async shutdown(cancelRunning = false): Promise<void> {
    this.closing = true;
    if (cancelRunning) for (const controller of this.controllers.values()) controller.abort(new Error("Queue shutdown"));
    await this.pumpPromise;
    await Promise.allSettled([...this.executions.values()]);
  }

  async recover(): Promise<void> {
    if (this.recovered) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.performRecover();
    try { await this.recoveryPromise; }
    finally { this.recoveryPromise = undefined; }
  }

  private async performRecover(): Promise<void> {
    this.pendingByProject.clear();
    this.idempotency.clear();
    for (const projectId of await this.store.listProjectIds()) {
      await this.store.sweepTemporaryFiles(projectId);
      for (const job of await this.store.listJobs(projectId)) {
        let current = job;
        if (job.status === "running") {
          current = { ...job, status: "queued", phase: "recovered", message: "Recovered after host restart", retryHistory: [...job.retryHistory, { attempt: Math.max(1, job.attempt), failureClass: "transient", error: "Host restarted while job was running", at: this.now() }], updatedAt: this.now() };
          await this.store.writeJob(projectId, current);
          await this.event(current, "job.retrying", "recovered", current.progress, current.message);
        }
        this.addPending(current);
        this.rememberIdempotency(current);
      }
    }
    this.recovered = true;
    this.schedulePump();
  }

  private schedulePump(delayMs = 0): void {
    if (this.closing) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    void this.clock.sleep(delayMs).then(() => { this.pumpScheduled = false; const pending = this.pump(); this.pumpPromise = pending; void pending.finally(() => { if (this.pumpPromise === pending) this.pumpPromise = undefined; }); });
  }

  private async pump(): Promise<void> {
    if (this.closing) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      if (this.running >= this.options.concurrency) return;
      for (const [projectId, queue] of [...this.pendingByProject.entries()]) {
        if (this.running >= this.options.concurrency) break;
        if (this.activeProjects.has(projectId)) continue;
        while (queue[0] && (queue[0].status !== "queued" || queue[0].cancellationRequested)) queue.shift();
        const job = queue[0];
        if (!job) { this.pendingByProject.delete(projectId); continue; }
        const typeLimit = this.options.typeConcurrency?.[job.type];
        if (typeLimit !== undefined && (this.activeTypes.get(job.type) ?? 0) >= typeLimit) continue;
        queue.shift();
        if (queue.length === 0) this.pendingByProject.delete(projectId);
        this.running += 1; this.activeProjects.add(projectId);
        this.activeTypes.set(job.type, (this.activeTypes.get(job.type) ?? 0) + 1);
        const execution = this.execute(job).finally(() => { this.running -= 1; this.activeProjects.delete(projectId); this.activeTypes.set(job.type, Math.max(0, (this.activeTypes.get(job.type) ?? 1) - 1)); this.executions.delete(job.id); this.schedulePump(); });
        this.executions.set(job.id, execution);
      }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) { this.pumpAgain = false; this.schedulePump(); }
    }
  }

  private async execute(original: Job): Promise<void> {
    const handler = this.handlers.get(original.type);
    if (!handler) { await this.fail(original, new Error(`No handler registered for ${original.type}`), "permanent"); return; }
    const controller = new AbortController(); this.controllers.set(original.id, controller);
    const latest = await this.store.readJob(original.projectId, original.id);
    if (latest.status === "cancelled" || latest.cancellationRequested) { this.controllers.delete(original.id); return; }
    const started: Job = { ...latest, status: "running", phase: "starting", progress: Math.max(latest.progress, 0.01), attempt: latest.attempt + 1, startedAt: latest.startedAt ?? this.now(), updatedAt: this.now() };
    this.rememberIdempotency(started);
    await this.store.writeJob(started.projectId, started); await this.event(started, "job.started", started.phase, started.progress);
    try {
      const output = await handler(started, { signal: controller.signal, progress: async (value, phase, message) => { if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Job cancelled"); const current = await this.store.readJob(started.projectId, started.id); if (current.status === "cancelled" || current.cancellationRequested) throw new Error("Job cancelled"); const next: Job = { ...current, progress: Math.max(current.progress, Math.min(0.99, value)), phase, ...(message ? { message } : {}), updatedAt: this.now() }; await this.store.writeJob(next.projectId, next); await this.event(next, "job.progress", phase, next.progress, message); } });
      const current = await this.store.readJob(started.projectId, started.id);
      if (current.status === "cancelled" || current.cancellationRequested || controller.signal.aborted) return;
      const completed: Job = { ...current, status: "succeeded", phase: "completed", progress: 1, output, finishedAt: this.now(), updatedAt: this.now() };
      this.rememberIdempotency(completed);
      await this.background.cancel(completed.id);
      await this.store.writeJob(completed.projectId, completed); await this.event(completed, "job.completed", completed.phase, 1);
    } catch (error) {
      const failureClass = classifyFailure(error, controller.signal);
      const current = await this.store.readJob(started.projectId, started.id);
      if (current.status === "cancelled" || current.cancellationRequested) return;
      if (failureClass === "cancelled") {
        const cancelled: Job = { ...current, status: "cancelled", cancellationRequested: true, phase: "cancelled", error: error instanceof Error ? error.message : String(error), failureClass: "cancelled", finishedAt: this.now(), updatedAt: this.now() };
        this.rememberIdempotency(cancelled);
        await this.store.writeJob(cancelled.projectId, cancelled); await this.background.cancel(cancelled.id); await this.event(cancelled, "job.cancelled", "cancelled", cancelled.progress, cancelled.error);
        return;
      }
      if (failureClass === "transient" && current.attempt < current.maxAttempts) {
        const retryMs = Math.round(this.options.baseRetryMs * 2 ** (current.attempt - 1) * (0.8 + Math.random() * 0.4));
        const retryDate = this.clock.now(); retryDate.setTime(retryDate.getTime() + retryMs); const retryAt = retryDate.toISOString();
        const queued: Job = { ...current, status: "queued", phase: "retrying", error: error instanceof Error ? error.message : String(error), failureClass, retryHistory: [...current.retryHistory, { attempt: current.attempt, failureClass, error: error instanceof Error ? error.message : String(error), at: this.now(), retryAt }], updatedAt: this.now() };
        await this.store.writeJob(queued.projectId, queued); await this.event(queued, "job.retrying", queued.phase, queued.progress, `Retrying at ${retryAt}`); this.addPending(queued); this.rememberIdempotency(queued); this.schedulePump(retryMs); return;
      }
      await this.fail(current, error, failureClass);
    } finally { this.controllers.delete(original.id); }
  }

  private async fail(job: Job, error: unknown, failureClass: FailureClass): Promise<void> {
    const failed: Job = { ...job, status: "failed", phase: "failed", error: error instanceof Error ? error.message : String(error), failureClass, finishedAt: this.now(), updatedAt: this.now() };
    this.rememberIdempotency(failed);
    await this.background.cancel(failed.id);
    await this.store.writeJob(failed.projectId, failed); await this.event(failed, "job.failed", failed.phase, failed.progress, failed.error);
  }

  private async event(job: Job, type: JobEvent["type"], phase: string, progress: number, message?: string): Promise<void> {
    const event: JobEvent = { id: this.ids.create(), jobId: job.id, projectId: job.projectId, type, phase, progress, ...(message ? { message } : {}), createdAt: this.now() };
    await this.store.writeJobEvent(job.projectId, event);
  }
}
