import type { ProviderCall } from "../../core/src/schemas.js";
import { FetchHttpAdapter, SystemClock, WebCryptoAdapter, WebIdAdapter } from "../../platform/src/portable.js";
import type { HttpAdapter, RuntimePrimitives } from "../../platform/src/contracts.js";
import type { StructuredTextGenerator } from "./speech-pipeline.js";

interface ChatBody {
  id?: string;
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

function textContent(body: ChatBody): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? "").join("");
  return "";
}

export type ChatProviderKind = "openai" | "deepseek" | "openrouter" | "openai-compatible" | "custom";
export type ChatReasoning = "off" | "low" | "medium" | "high" | "extra-high";

export class ChatCompletionsStructuredGenerator implements StructuredTextGenerator {
  readonly id: string;
  private readonly primitives: RuntimePrimitives;

  constructor(
    readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    private readonly kind: ChatProviderKind = "openai-compatible",
    private readonly reasoning: ChatReasoning = "off",
    private readonly http: HttpAdapter = new FetchHttpAdapter(),
    primitives?: RuntimePrimitives,
    private readonly timeoutMs = 120_000,
  ) {
    this.id = kind;
    this.primitives = primitives ?? { clock: new SystemClock(), ids: new WebIdAdapter(), crypto: new WebCryptoAdapter() };
  }

  private reasoningPayload(): Record<string, unknown> {
    if (this.reasoning === "off" || this.kind === "deepseek") return {};
    const effort = this.reasoning === "extra-high" ? "high" : this.reasoning;
    if (this.kind === "openai") return { reasoning_effort: effort };
    if (this.kind === "openrouter") return { reasoning: { effort } };
    return {};
  }

  async generateStructured<T>(request: Parameters<StructuredTextGenerator["generateStructured"]>[0]): Promise<import("../../providers/src/contracts.js").StructuredGenerationResult<T>> {
    if (!this.apiKey) throw new Error("VIDEO_AGENT_LLM_API_KEY (or provider-specific mapped key) is required");
    const started = this.primitives.clock.now().getTime();
    const maxAttempts = (request.maxRetries ?? 2) + 1;
    let retryCount = 0;
    let lastIssues: string[] = [];
    let requestId: string | undefined;
    let usage: ProviderCall["usage"];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("Cancelled");
      const repair = lastIssues.length > 0
        ? `\n\nYour previous JSON was invalid. Fix these issues and return the entire JSON object: ${lastIssues.join("; ")}`
        : "";
      const response = await this.http.request({
        method: "POST",
        url: `${this.baseUrl.replace(/\/$/u, "")}/chat/completions`,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: `${request.instructions}\nReturn only a JSON object matching this JSON Schema:\n${JSON.stringify(request.jsonSchema)}` },
            { role: "user", content: `${request.input}${repair}` },
          ],
          response_format: { type: "json_object" },
          ...this.reasoningPayload(),
        }),
        timeoutMs: this.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      let body: ChatBody;
      try { body = JSON.parse(new TextDecoder().decode(response.body)) as ChatBody; }
      catch (error) { throw new Error(`Chat Completions returned invalid response JSON: ${error instanceof Error ? error.message : String(error)}`); }
      requestId = response.headers["x-request-id"] ?? body.id;
      usage = body.usage ? { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens, totalTokens: body.usage.total_tokens } : undefined;

      if (response.status < 200 || response.status >= 300) {
        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
          retryCount += 1;
          await this.primitives.clock.sleep(Math.min(2_000, 250 * 2 ** (attempt - 1)), request.signal);
          continue;
        }
        throw new Error(`${this.kind} chat completion failed (${response.status}): ${body.error?.message ?? "request failed"}`);
      }

      let parsed: unknown;
      try { parsed = JSON.parse(textContent(body)); }
      catch (error) {
        lastIssues = [`malformed JSON: ${error instanceof Error ? error.message : String(error)}`];
        if (attempt < maxAttempts) { retryCount += 1; continue; }
        throw new Error(`Structured chat output was malformed after ${attempt} attempts: ${lastIssues.join("; ")}`);
      }
      const validated = request.schema.safeParse(parsed);
      if (!validated.success) {
        lastIssues = validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
        if (attempt < maxAttempts) { retryCount += 1; continue; }
        throw new Error(`Structured chat output failed validation after ${attempt} attempts: ${lastIssues.join("; ")}`);
      }

      const metadata: ProviderCall = {
        id: this.primitives.ids.create(),
        ...(request.projectId ? { projectId: request.projectId } : {}),
        operation: request.operation,
        provider: this.kind,
        model: this.model,
        ...(requestId ? { requestId } : {}),
        latencyMs: this.primitives.clock.now().getTime() - started,
        ...(usage ? { usage } : {}),
        retryCount,
        validation: { valid: true, issues: [] },
        status: "succeeded",
        createdAt: this.primitives.clock.now().toISOString(),
      };
      return { value: validated.data as T, metadata };
    }
    throw new Error("Structured chat generation exhausted retries");
  }
}
