import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";
import { editPatchSchema, editPlanSchema, editingStrategySchema, type EditPatch, type EditPlan, type EditingStrategy, type ProviderCall, type ReasoningLevel, type Transcript } from "../../core/src/schemas.js";
import type { LLMCapabilities, LLMProvider, OperationContext, ProviderHealth, StructuredGenerationRequest, StructuredGenerationResult } from "./contracts.js";
import { FetchHttpAdapter, SystemClock, WebCryptoAdapter, WebIdAdapter } from "../../platform/src/portable.js";
import type { HttpAdapter, RuntimePrimitives } from "../../platform/src/contracts.js";

interface ResponsesBody { id?: string; status?: string; output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }; error?: { message?: string } }

const EDITING_STRATEGY_JSON_SCHEMA = zodToJsonSchema(editingStrategySchema, { $refStrategy: "none" }) as Record<string, unknown>;
const EDIT_PLAN_JSON_SCHEMA = zodToJsonSchema(editPlanSchema, { $refStrategy: "none" }) as Record<string, unknown>;
const EDIT_PATCH_JSON_SCHEMA = zodToJsonSchema(editPatchSchema, { $refStrategy: "none" }) as Record<string, unknown>;
const MAX_PENDING_CALLS = 32;

function outputText(body: ResponsesBody): string {
  if (body.output_text) return body.output_text;
  let result = "";
  for (const item of body.output ?? []) for (const part of item.content ?? []) if (part.type === "output_text" && part.text) result += part.text;
  return result;
}

function compactTranscript(transcript: Transcript) {
  return {
    language: transcript.language,
    quality: transcript.quality,
    segments: transcript.segments.map((segment) => ({ id: segment.id, startUs: segment.startUs, endUs: segment.endUs, speakerId: segment.speakerId, text: segment.normalizedText })),
  };
}

function cancelledError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Cancelled");
}

export class OpenAILLMProvider implements LLMProvider {
  readonly id = "openai";
  private readonly controllers = new Map<string, AbortController>();
  private readonly calls: ProviderCall[] = [];
  private readonly primitives: RuntimePrimitives;

  constructor(readonly model: string, private readonly apiKey: string | undefined, private readonly baseUrl = "https://api.openai.com/v1", private readonly timeoutMs = 120_000, private readonly http: HttpAdapter = new FetchHttpAdapter(), primitives?: RuntimePrimitives, private readonly reasoning: ReasoningLevel = "off") { this.primitives = primitives ?? { clock: new SystemClock(), ids: new WebIdAdapter(), crypto: new WebCryptoAdapter() }; }
  private idValue() { return this.primitives.ids.create(); }
  private now() { return this.primitives.clock.now().toISOString(); }
  private recordCall(call: ProviderCall) { this.calls.push(call); if (this.calls.length > MAX_PENDING_CALLS) this.calls.splice(0, this.calls.length - MAX_PENDING_CALLS); }

  capabilities(): LLMCapabilities { return { structuredOutput: true, cancellation: true, tokenUsage: true, repair: true }; }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult<T>> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required when VIDEO_AGENT_PLANNER=openai");
    if (request.signal?.aborted) throw cancelledError(request.signal);
    const started = this.primitives.clock.now().getTime();
    const controller = new AbortController();
    this.controllers.set(request.requestId, controller);
    const forwardAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    let retryCount = 0;
    let validationIssues: string[] = [];
    let providerRequestId: string | undefined;
    let usage: ProviderCall["usage"];
    try {
      const maxAttempts = (request.maxRetries ?? 2) + 1;
      let repair = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (controller.signal.aborted) throw cancelledError(controller.signal);
        const response = await this.http.request({ url: `${this.baseUrl}/responses`,
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, store: false, instructions: request.instructions, input: `${request.input}${repair}`, ...(this.reasoning === "off" ? {} : { reasoning: { effort: this.reasoning === "extra-high" ? "xhigh" : this.reasoning } }), text: { format: { type: "json_schema", name: request.schemaName, schema: request.jsonSchema, strict: false } } }),
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
        });
        if (controller.signal.aborted) throw cancelledError(controller.signal);
        const responseText = new TextDecoder().decode(response.body);
        let body: ResponsesBody;
        try { body = JSON.parse(responseText) as ResponsesBody; }
        catch { body = { error: { message: responseText.slice(0, 1_000) || "non-JSON response" } }; }
        providerRequestId = response.headers["x-request-id"] ?? body.id;
        usage = body.usage ? { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens, totalTokens: body.usage.total_tokens } : undefined;
        if (response.status < 200 || response.status >= 300) {
          if (response.status >= 500 || response.status === 429) {
            if (attempt < maxAttempts) { retryCount += 1; await this.primitives.clock.sleep(Math.min(2_000, 250 * 2 ** (attempt - 1)), controller.signal); continue; }
          }
          throw new Error(`OpenAI Responses API failed (${response.status}): ${body.error?.message ?? "request failed"}`);
        }
        const text = outputText(body);
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch (error) { validationIssues = [`malformed JSON: ${error instanceof Error ? error.message : String(error)}`]; parsed = undefined; }
        const validated = request.schema.safeParse(parsed);
        if (validated.success) {
          const metadata: ProviderCall = { id: this.idValue(), ...(request.projectId ? { projectId: request.projectId } : {}), operation: request.operation, provider: this.id, model: this.model, ...(providerRequestId ? { requestId: providerRequestId } : {}), latencyMs: this.primitives.clock.now().getTime() - started, ...(usage ? { usage } : {}), retryCount, validation: { valid: true, issues: [] }, status: "succeeded", createdAt: this.now() };
          this.recordCall(metadata);
          return { value: validated.data, metadata };
        }
        validationIssues = validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
        if (attempt < maxAttempts) { retryCount += 1; repair = `\n\nYour previous response was invalid. Correct only these validation errors and return the entire JSON object: ${validationIssues.join("; ")}`; continue; }
      }
      throw new Error(`OpenAI structured output failed validation after ${retryCount + 1} attempts: ${validationIssues.join("; ")}`);
    } catch (error) {
      const cancelled = controller.signal.aborted || request.signal?.aborted;
      this.recordCall({ id: this.idValue(), ...(request.projectId ? { projectId: request.projectId } : {}), operation: request.operation, provider: this.id, model: this.model, ...(providerRequestId ? { requestId: providerRequestId } : {}), latencyMs: this.primitives.clock.now().getTime() - started, ...(usage ? { usage } : {}), retryCount, validation: { valid: false, issues: validationIssues }, status: cancelled ? "cancelled" : "failed", createdAt: this.now() });
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
      this.controllers.delete(request.requestId);
    }
  }

  async proposeStrategy(input: { projectId: string; prompt: string; transcript: Transcript; targetDurationUs: number }, context?: OperationContext): Promise<EditingStrategy> {
    const requestId = this.idValue();
    const result = await this.generateStructured<EditingStrategy>({ requestId, projectId: input.projectId, operation: "strategy", schemaName: "editing_strategy", schema: editingStrategySchema as unknown as ZodType<EditingStrategy>, jsonSchema: EDITING_STRATEGY_JSON_SCHEMA, instructions: "You are the Strategy Planner for a transcript-first video editor. Return only the requested strategy. Preserve meaning, cite rationale from transcript evidence, and use integer microseconds.", input: JSON.stringify({ projectId: input.projectId, userIntent: input.prompt, targetDurationUs: input.targetDurationUs, transcript: compactTranscript(input.transcript), required: { schemaVersion: 1, status: "proposed", uniqueId: true, createdAt: "ISO-8601 now" } }), ...(context?.signal ? { signal: context.signal } : {}) });
    return result.value;
  }

  async createEditPlan(input: { projectId: string; strategy: EditingStrategy; transcript: Transcript; assetId: string; basedOnVersion: number }, context?: OperationContext): Promise<EditPlan> {
    const result = await this.generateStructured<EditPlan>({ requestId: this.idValue(), projectId: input.projectId, operation: "edit-plan", schemaName: "edit_plan", schema: editPlanSchema as unknown as ZodType<EditPlan>, jsonSchema: EDIT_PLAN_JSON_SCHEMA, instructions: "You are the Edit Planner. Select exact source ranges from transcript segments. Never invent media or wording. Output non-overlapping timeline segments with integer microseconds and a concise reason for every segment.", input: JSON.stringify({ projectId: input.projectId, assetId: input.assetId, basedOnVersion: input.basedOnVersion, strategy: input.strategy, transcript: compactTranscript(input.transcript), required: { schemaVersion: 1, strategyId: input.strategy.id, uniqueIds: true, createdAt: "ISO-8601 now" } }), ...(context?.signal ? { signal: context.signal } : {}) });
    return result.value;
  }

  async createEditPatch(input: { projectId: string; plan: EditPlan; timeline: import("../../core/src/schemas.js").Timeline; transcript: Transcript; feedback: Array<{ id: string; message: string; range?: { startUs: number; endUs: number } }>; basedOnVersion: number }, context?: OperationContext): Promise<EditPatch> {
    const result = await this.generateStructured<EditPatch>({ requestId: this.idValue(), projectId: input.projectId, operation: "patch-plan", schemaName: "edit_patch", schema: editPatchSchema as unknown as ZodType<EditPatch>, jsonSchema: EDIT_PATCH_JSON_SCHEMA, instructions: "You are the Patch Planner. Make the smallest reversible change satisfying feedback. Scope must match the affected range. Do not modify clips outside a local request unless globalChangeJustification explicitly explains why.", input: JSON.stringify({ projectId: input.projectId, basedOnVersion: input.basedOnVersion, plan: input.plan, timeline: input.timeline, feedback: input.feedback, transcript: compactTranscript(input.transcript), required: { schemaVersion: 1, uniqueId: true, createdAt: "ISO-8601 now" } }), ...(context?.signal ? { signal: context.signal } : {}) });
    return result.value;
  }

  takeLastCall(projectId?: string): ProviderCall | undefined {
    const index = projectId ? this.calls.findLastIndex((call) => call.projectId === projectId) : this.calls.length - 1;
    if (index < 0) return undefined;
    return this.calls.splice(index, 1)[0];
  }
  async cancel(requestId: string): Promise<void> { this.controllers.get(requestId)?.abort(new Error("Cancelled")); }
  async health(): Promise<ProviderHealth> {
    if (!this.apiKey) return { id: this.id, status: "unavailable", message: "OPENAI_API_KEY is not configured", capabilities: { ...this.capabilities() } };
    const controller = new AbortController();
    try { const response = await this.http.request({ method: "GET", url: `${this.baseUrl}/models`, headers: { authorization: `Bearer ${this.apiKey}` }, signal: controller.signal, timeoutMs: 5_000 }); const ok = response.status >= 200 && response.status < 300; return { id: this.id, status: ok ? "ready" : "degraded", message: ok ? `Responses planner ${this.model} configured` : `OpenAI health check returned ${response.status}`, capabilities: { ...this.capabilities() } }; }
    catch (error) { return { id: this.id, status: "unavailable", message: error instanceof Error ? error.message : String(error), capabilities: { ...this.capabilities() } }; }
    finally { controller.abort(); }
  }
}
