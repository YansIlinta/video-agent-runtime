import { providerConfigSchema, type ProviderConfig, type ReasoningLevel } from "../../core/src/index.js";
import { PortableError, type HttpAdapter, type SecureStorageAdapter } from "../../platform/src/index.js";

export interface DiscoveredModel { id: string; name: string; reasoning: ReasoningLevel[]; source: "api" | "static" }

const FALLBACK_MODELS: Record<ProviderConfig["kind"], string[]> = {
  openai: ["gpt-5.4-mini", "gpt-4.1-mini"], anthropic: ["claude-sonnet-4-5"], gemini: ["gemini-2.5-flash"], deepseek: ["deepseek-chat", "deepseek-reasoner"], openrouter: ["openai/gpt-4.1-mini"], "openai-compatible": [], custom: [],
};
const reasoning = (id: string): ReasoningLevel[] => /reason|o\d|gpt-5|thinking/iu.test(id) ? ["off", "low", "medium", "high", "extra-high"] : ["off"];

export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>();
  constructor(private readonly http: HttpAdapter, private readonly secrets: SecureStorageAdapter) {}
  set(input: ProviderConfig): ProviderConfig { const config = providerConfigSchema.parse(input); this.configs.set(config.id, config); return config; }
  get(id: string): ProviderConfig { const config = this.configs.get(id); if (!config) throw new PortableError("NOT_FOUND", `Provider config ${id} not found`); return config; }
  list(): ProviderConfig[] { return [...this.configs.values()]; }
  remove(id: string): void { this.configs.delete(id); }
  async credential(config: ProviderConfig): Promise<string | undefined> { return config.credentialRef ? this.secrets.get(config.credentialRef) : undefined; }
  async discoverModels(id: string): Promise<DiscoveredModel[]> {
    const config = this.get(id); const fallback = FALLBACK_MODELS[config.kind].map((model) => ({ id: model, name: model, reasoning: reasoning(model), source: "static" as const }));
    if (config.modelDiscovery === "static") return fallback;
    const credential = await this.credential(config);
    try {
      const response = await this.http.request({ method: "GET", url: `${config.baseUrl.replace(/\/$/u, "")}/models`, headers: credential ? { authorization: `Bearer ${credential}` } : {}, timeoutMs: 10_000 });
      if (response.status < 200 || response.status >= 300) throw new PortableError("PROVIDER_ERROR", `Model discovery returned ${response.status}`, response.status >= 500);
      const payload = JSON.parse(new TextDecoder().decode(response.body)) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ name?: string; displayName?: string }> };
      const models = payload.data?.flatMap((item) => item.id ? [{ id: item.id, name: item.name ?? item.id, reasoning: reasoning(item.id), source: "api" as const }] : []) ?? payload.models?.flatMap((item) => item.name ? [{ id: item.name.replace(/^models\//u, ""), name: item.displayName ?? item.name, reasoning: reasoning(item.name), source: "api" as const }] : []) ?? [];
      return models.length > 0 ? models : fallback;
    } catch (error) { if (config.modelDiscovery === "api") throw error; return fallback; }
  }
}

export function providerReasoningPayload(config: ProviderConfig): Record<string, unknown> {
  if (config.reasoning === "off") return {};
  const effort = config.reasoning === "extra-high" ? "xhigh" : config.reasoning;
  if (config.kind === "anthropic") return { thinking: { type: "enabled", budget_tokens: effort === "high" || effort === "xhigh" ? 16_000 : effort === "medium" ? 8_000 : 2_000 } };
  if (config.kind === "gemini") return { generationConfig: { thinkingConfig: { thinkingBudget: effort === "high" || effort === "xhigh" ? 16_000 : effort === "medium" ? 8_000 : 2_000 } } };
  return { reasoning: { effort } };
}
