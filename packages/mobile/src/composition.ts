import type { ProviderConfig, Transcript } from "../../core/src/schemas.js";
import { OpenAILLMProvider } from "../../providers/src/openai.js";
import type { ASRProvider, ASRResult, LLMProvider, OperationContext, StructuredGenerationRequest, TTSProvider } from "../../providers/src/contracts.js";
import { VideoAgentCore } from "../../runtime/src/video-agent-core.js";
import { StructuredLogger } from "../../runtime/src/logger.js";
import type { HttpAdapter, RuntimePrimitives } from "../../platform/src/contracts.js";
import { createNativeHostProfile } from "./adapters.js";
import type { NativeVideoHostBridge } from "./native-bridge.js";
import { MobileProjectRepository } from "./project-repository.js";
import { MobileProviderSettings } from "./provider-settings.js";
import { NativeMobileRenderer } from "./renderer.js";
import { createMobilePreviewSelfCheck } from "./self-check.js";
import { buildMobileContextPack } from "./privacy.js";
import { AuditedMobileHttpAdapter } from "./network-audit.js";

/**
 * There is no on-device transcription yet. The previous fixture ignored the audio and returned a
 * fixed paragraph, so every downstream strategy, plan and cut was computed against invented
 * content while appearing to work. Failing loudly is the honest behaviour until a real provider
 * is wired; see docs/mobile/local-models.md for the milestone.
 */
class UnavailableASRProvider implements ASRProvider {
  readonly id = "mobile-asr-unavailable"; readonly model = "not-integrated";
  capabilities() { return { wordTimestamps: false, segmentTimestamps: false, speakerDiarization: false, languageDetection: false, streaming: false, confidence: false, forcedAlignment: false }; }
  async transcribe(): Promise<ASRResult> { throw new Error("On-device transcription is not implemented on this host. Configure an ASR provider before proposing an edit."); }
}

class UnavailableTTS implements TTSProvider {
  readonly id = "mobile-tts-unavailable"; readonly model = "not-integrated";
  capabilities() { return { streaming: false, voiceSelection: false, voiceCloning: false, styleControl: false, speedControl: false, multilingual: false, timestamps: false, phonemeAlignment: false }; }
  async synthesize(): Promise<never> { throw new Error("Local TTS is intentionally deferred until after local ASR"); }
}

class MutablePlanner implements LLMProvider {
  readonly id = "mobile-configurable-planner"; get model() { return this.current?.model ?? "unconfigured"; }
  private current?: LLMProvider;
  set(provider: LLMProvider) { this.current = provider; }
  private provider() { if (!this.current) throw new Error("Configure and test a provider before planning"); return this.current; }
  capabilities() { return this.current?.capabilities?.() ?? { structuredOutput: true, cancellation: true, tokenUsage: true, repair: true }; }
  generateStructured<T>(request: StructuredGenerationRequest<T>) { const provider = this.provider(); const method = provider.generateStructured; if (!method) throw new Error("Provider does not support structured output"); return method.call(provider, request) as ReturnType<NonNullable<LLMProvider["generateStructured"]>> as Promise<import("../../providers/src/contracts.js").StructuredGenerationResult<T>>; }
  proposeStrategy(input: Parameters<LLMProvider["proposeStrategy"]>[0], context?: OperationContext) { return this.provider().proposeStrategy(input, context); }
  createEditPlan(input: Parameters<LLMProvider["createEditPlan"]>[0], context?: OperationContext) { return this.provider().createEditPlan(input, context); }
  createEditPatch(input: Parameters<NonNullable<LLMProvider["createEditPatch"]>>[0], context?: OperationContext) { const method = this.provider().createEditPatch; if (!method) throw new Error("Provider does not support patch planning"); return method.call(this.provider(), input, context); }
  takeLastCall(projectId?: string) { return this.current?.takeLastCall?.(projectId); }
  health() { return this.current?.health?.() ?? Promise.resolve({ id: this.id, status: "unavailable" as const, message: "Provider is not configured" }); }
}

export interface MobileHostComposition { core: VideoAgentCore; facade: VideoAgentFacade; repository: MobileProjectRepository; providerSettings: MobileProviderSettings; profile: Awaited<ReturnType<typeof createNativeHostProfile>>["profile"] }

export class VideoAgentFacade {
  private providerConfig?: ProviderConfig;
  private lastPrivacy?: Awaited<ReturnType<typeof buildMobileContextPack>>["evidence"];
  constructor(private readonly core: VideoAgentCore, private readonly native: NativeVideoHostBridge, private readonly planner: MutablePlanner, private readonly settings: MobileProviderSettings, private readonly http: AuditedMobileHttpAdapter, private readonly primitives: RuntimePrimitives) {}
  createProject(name: string) { return this.core.createProject(name); }
  async importVideo(projectId: string) { const picked = await this.native.pickVideo(); if (!picked) return undefined; return this.core.importVideo(projectId, picked.sourceUri); }
  connectProvider(config: ProviderConfig, apiKey?: string) { return this.configureProvider(config, apiKey); }
  async configureProvider(config: ProviderConfig, apiKey?: string, providerFactory?: (config: ProviderConfig, credential?: string) => LLMProvider) { const saved = await this.settings.save(config, apiKey); if (!["openai", "openai-compatible", "custom"].includes(saved.kind) && !providerFactory) throw new Error(`${saved.kind} direct provider implementation is not included in this proof`); const credential = saved.credentialRef ? await this.settings.credential(saved.credentialRef) : undefined; const provider = providerFactory?.(saved, credential) ?? new OpenAILLMProvider(saved.model, credential, saved.baseUrl, 120_000, this.http, this.primitives, saved.reasoning); this.planner.set(provider); this.providerConfig = saved; return { config: saved, health: await provider.health?.() }; }
  async proposeEdit(projectId: string, assetId: string, prompt: string, targetDurationUs = 30_000_000) { let transcript: Transcript; try { transcript = await this.core.readTranscript(projectId); } catch { transcript = await this.core.transcribe(projectId, assetId, { language: "zh" }); } if (!this.providerConfig) throw new Error("Configure a provider before remote planning"); this.lastPrivacy = (await buildMobileContextPack(this.primitives, { projectId, provider: this.providerConfig, approvedAt: this.primitives.clock.now().toISOString(), transcript })).evidence; return this.core.proposeStrategy(projectId, prompt, targetDurationUs); }
  async approveProposal(projectId: string, strategyId: string) { const strategy = await this.core.approveStrategy(projectId, strategyId); const plan = await this.core.createEditPlan(projectId); const validation = await this.core.validatePlan(projectId, plan.id); if (!validation.valid) throw new Error(`EditPlan rejected: ${validation.issues.map((item) => item.message).join("; ")}`); const version = await this.core.applyPlan(projectId, plan.id); return { strategy, plan, validation, version }; }
  renderPreview(projectId: string, range?: { startUs: number; endUs: number }) { return this.core.renderPreview(projectId, range); }
  submitFeedback(projectId: string, message: string, range?: { startUs: number; endUs: number }) { return this.core.submitFeedback(projectId, message, { ...(range ? { range } : {}) }); }
  async applyPatch(projectId: string) { if (this.providerConfig) { const [transcript, timeline, feedback] = await Promise.all([this.core.readTranscript(projectId), this.core.store.readTimeline(projectId), this.core.store.listFeedback(projectId)]); this.lastPrivacy = (await buildMobileContextPack(this.primitives, { projectId, provider: this.providerConfig, approvedAt: this.primitives.clock.now().toISOString(), transcript, timeline, feedback })).evidence; } const patch = await this.core.createPatch(projectId); const validation = await this.core.validatePatch(projectId, patch.id); if (!validation.valid) throw new Error(`EditPatch rejected: ${validation.issues.map((item) => item.message).join("; ")}`); return { patch, version: await this.core.applyPatch(projectId, patch.id) }; }
  listVersions(projectId: string) { return this.core.listVersions(projectId); }
  restoreVersion(projectId: string, version: number) { return this.core.restoreVersion(projectId, version); }
  async exportVideo(projectId: string) { await this.core.approveFinal(projectId); return this.core.exportVideo(projectId); }
  listJobs(projectId: string) { return this.core.listJobs(projectId); }
  cancelJob(projectId: string, jobId: string) { return this.core.cancelJob(projectId, jobId); }
  status(projectId: string) { return this.core.status(projectId); }
  privacyEvidence() { return this.lastPrivacy; }
  networkAudit() { return [...this.http.records]; }
}

export async function createMobileHost(native: NativeVideoHostBridge): Promise<MobileHostComposition> {
  const { profile } = await createNativeHostProfile(native);
  const budget = profile.capabilities.resourceBudget;
  const repository = new MobileProjectRepository(profile.filesystem, native, profile.primitives.clock, profile.primitives.ids, profile.primitives.crypto);
  const providerSettings = new MobileProviderSettings(profile.filesystem, profile.secureStorage);
  const planner = new MutablePlanner();
  const platform = await native.platform();
  const renderer = new NativeMobileRenderer(native, { platform, previewMaxWidth: budget.previewMaxWidth, createId: () => profile.primitives.ids.create() });
  const core = new VideoAgentCore(
    repository,
    { asr: new UnavailableASRProvider(), tts: new UnavailableTTS(), planner, renderer, mediaProbe: { probe: (uri) => native.probe(uri as never) }, previewSelfCheck: createMobilePreviewSelfCheck(native) },
    // A phone is not a workstation: cap the import at the device's own working-set budget rather
    // than at the Node host's 5 GB.
    { maxUploadBytes: Math.max(256 * 1024 * 1024, budget.maxWorkingSetBytes * 4), maxPreviewDurationUs: budget.previewMaxDurationUs, maxConcurrentJobs: 1, maxFfmpegProcesses: 1 },
    new StructuredLogger("error"), profile.primitives, profile.background,
  );
  const auditedHttp = new AuditedMobileHttpAdapter(profile.http);
  await core.jobs.recover();
  return { core, facade: new VideoAgentFacade(core, native, planner, providerSettings, auditedHttp, profile.primitives), repository, providerSettings, profile };
}
