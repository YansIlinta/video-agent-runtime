import type { WorkflowRun, WorkflowState } from "./schemas.js";
import { SystemClock, WebIdAdapter } from "../../platform/src/portable.js";
import type { ClockAdapter, IdAdapter } from "../../platform/src/contracts.js";

export interface WorkflowStore { readWorkflow(projectId: string): Promise<WorkflowRun>; writeWorkflow(projectId: string, workflow: WorkflowRun): Promise<void> }

const allowed: Record<WorkflowState, WorkflowState[]> = {
  CREATED: ["INGESTING", "FAILED"],
  INGESTING: ["TRANSCRIBING", "ANALYZING", "READY", "FAILED"],
  TRANSCRIBING: ["ANALYZING", "READY", "FAILED"],
  ANALYZING: ["READY", "FAILED"],
  READY: ["PROPOSING", "PLANNING", "FAILED"],
  PROPOSING: ["WAITING_PROPOSAL_APPROVAL", "FAILED"],
  WAITING_PROPOSAL_APPROVAL: ["PLANNING", "PROPOSING", "FAILED"],
  PLANNING: ["VALIDATING", "FAILED"],
  VALIDATING: ["APPLYING", "PLANNING", "FAILED"],
  APPLYING: ["RENDERING_PREVIEW", "WAITING_REVIEW", "FAILED"],
  RENDERING_PREVIEW: ["EVALUATING_PREVIEW", "WAITING_REVIEW", "FAILED"],
  EVALUATING_PREVIEW: ["WAITING_REVIEW", "FAILED"],
  WAITING_REVIEW: ["PROCESSING_FEEDBACK", "RENDERING_PREVIEW", "WAITING_FINAL_APPROVAL", "EXPORTING", "FAILED"],
  PROCESSING_FEEDBACK: ["DIAGNOSING", "PATCHING", "FAILED"],
  DIAGNOSING: ["PATCHING", "REPLANNING", "WAITING_REVIEW", "FAILED"],
  PATCHING: ["VALIDATING", "RENDERING_PREVIEW", "FAILED"],
  REPLANNING: ["WAITING_PROPOSAL_APPROVAL", "PLANNING", "FAILED"],
  WAITING_FINAL_APPROVAL: ["EXPORTING", "WAITING_REVIEW", "FAILED"],
  EXPORTING: ["DONE", "FAILED"],
  DONE: ["PROCESSING_FEEDBACK"],
  FAILED: ["INGESTING", "TRANSCRIBING", "ANALYZING", "READY", "PROPOSING", "PLANNING", "VALIDATING", "APPLYING", "RENDERING_PREVIEW", "PROCESSING_FEEDBACK", "DIAGNOSING", "PATCHING", "REPLANNING", "EXPORTING"],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return allowed[from].includes(to);
}

export class WorkflowEngine {
  constructor(private readonly store: WorkflowStore, private readonly clock: ClockAdapter = new SystemClock(), private readonly ids: IdAdapter = new WebIdAdapter()) {}
  private now() { return this.clock.now().toISOString(); }

  async runStep<T>(projectId: string, to: WorkflowState, input: unknown, action: () => Promise<T>): Promise<T> {
    let workflow = await this.store.readWorkflow(projectId);
    const from = workflow.state;
    if (!canTransition(from, to)) throw new Error(`Invalid workflow transition ${from} -> ${to}`);
    const step = { id: this.ids.create(), from, to, status: "running" as const, input, retryCount: 0, startedAt: this.now() };
    workflow = { ...workflow, state: to, steps: [...workflow.steps, step], updatedAt: this.now() };
    await this.store.writeWorkflow(projectId, workflow);
    try {
      const output = await action();
      const completed = { ...step, status: "completed" as const, output, completedAt: this.now() };
      workflow = { ...workflow, steps: [...workflow.steps.slice(0, -1), completed], updatedAt: this.now() };
      await this.store.writeWorkflow(projectId, workflow);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = { ...step, status: "failed" as const, error: message, completedAt: this.now() };
      workflow = { ...workflow, state: "FAILED", steps: [...workflow.steps.slice(0, -1), failed], updatedAt: this.now() };
      await this.store.writeWorkflow(projectId, workflow);
      throw error;
    }
  }

  async move(projectId: string, to: WorkflowState, input?: unknown): Promise<WorkflowRun> {
    await this.runStep(projectId, to, input, async () => ({ acknowledged: true }));
    return this.store.readWorkflow(projectId);
  }

  async recover(projectId: string): Promise<WorkflowRun> {
    const workflow = await this.store.readWorkflow(projectId);
    const last = workflow.steps.at(-1);
    if (!last || last.status !== "running") return workflow;
    const failed = { ...last, status: "failed" as const, error: "Host restarted while step was running", completedAt: this.now(), retryCount: last.retryCount + 1 };
    const recovered = { ...workflow, state: "FAILED" as const, steps: [...workflow.steps.slice(0, -1), failed], updatedAt: this.now() };
    await this.store.writeWorkflow(projectId, recovered);
    return recovered;
  }
}
