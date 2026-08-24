import type { ProviderConfig, Transcript } from "../../core/src/schemas.js";
import { OpenAILLMProvider } from "../../providers/src/openai.js";
import type { LLMProvider, OperationContext, StructuredGenerationRequest } from "../../providers/src/contracts.js";
import { VideoAgentCore } from "../../runtime/src/video-agent-core.js";
import { StructuredLogger } from "../../runtime/src/logger.js";
import type { RuntimePrimitives } from "../../platform/src/contracts.js";
import { createNativeHostProfile } from "./adapters.js";
import type { NativeVideoHostBridge } from "./native-bridge.js";
import type { MobileOpenAIASRModel, NativeSpeechHostBridge } from "./native-speech-bridge.js";
import { MobileProjectRepository } from "./project-repository.js";
import { MobileProviderSettings, type MobileProviderSlot } from "./provider-settings.js";
import { NativeMobileRenderer } from "./renderer.js";
import { createMobilePreviewSelfCheck } from "./self-check.js";
import { buildMobileContextPack } from "./privacy.js";
import { AuditedMobileHttpAdapter } from "./network-audit.js";
import { MobileOpenAIASRProvider, MobileOpenAITTSProvider, MutableASRProvider, MutableTTSProvider } from "./speech-providers.js";

const OFFICIAL_OPENAI_BASE = "https://api.openai.com/v1";
function assertOfficialSpeechConfig(config: ProviderConfig, role: "ASR" | "TTS") {
  if (config.kind !== "openai") throw new Error(`Mobile hosted ${role} currently supports the official OpenAI endpoint only`);
  if (config.baseUrl.replace(/\/+$/u, "") !== OFFICIAL_OPENAI_BASE) throw new Error(`Mobile hosted ${role} is pinned to ${OFFICIAL_OPENAI_BASE}`);
}

class MutablePlanner implements LLMProvider {
  readonly id = "mobile-configurable-planner"; get model() { return this.current?.model ?? "unconfigured"; }
  private current?: LLMProvider;
  set(provider: LLMProvider) { this.current = provider; }
  configured() { return this.current !== undefined; }
  private provider() { if (!this.current) throw new Error("Configure and test a planner before planning"); return this.current; }
  capabilities() { return this.current?.capabilities?.() ?? { structuredOutput: true, cancellation: true, tokenUsage: true, repair: true }; }
  generateStructured<T>(request: StructuredGenerationRequest<T>) { const provider = this.provider(); const method = provider.generateStructured; if (!method) throw new Error("Provider does not support structured output"); return method.call(provider, request) as ReturnType<NonNullable<LLMProvider["generateStructured"]>> as Promise<import("../../providers/src/contracts.js").StructuredGenerationResult<T>>; }
  proposeStrategy(input: Parameters<LLMProvider["proposeStrategy"]>[0], context?: OperationContext) { return this.provider().proposeStrategy(input, context); }
  createEditPlan(input: Parameters<LLMProvider["createEditPlan"]>[0], context?: OperationContext) { return this.provider().createEditPlan(input, context); }
  createEditPatch(input: Parameters<NonNullable<LLMProvider["createEditPatch"]>>[0], context?: OperationContext) { const provider = this.provider(); const method = provider.createEditPatch; if (!method) throw new Error("Provider does not support patch planning"); return method.call(provider, input, context); }
  takeLastCall(projectId?: string) { return this.current?.takeLastCall?.(projectId); }
  health() { return this.current?.health?.() ?? Promise.resolve({ id: this.id, status: "unavailable" as const, message: "Planner is not configured" }); }
}

export interface MobileHostComposition {
  core: VideoAgentCore;
  facade: VideoAgentFacade;
  repository: MobileProjectRepository;
  providerSettings: MobileProviderSettings;
  profile: Awaited<ReturnType<typeof createNativeHostProfile>>["profile"];
  providerRestoreErrors: Array<{ slot: MobileProviderSlot; message: string }>;
}

export class VideoAgentFacade {
  private plannerConfig?: ProviderConfig;
  private lastPrivacy?: Awaited<ReturnType<typeof buildMobileContextPack>>["evidence"];
  constructor(
    private readonly core: VideoAgentCore,
    private readonly native: NativeVideoHostBridge,
    private readonly speechNative: NativeSpeechHostBridge | undefined,
    private readonly planner: MutablePlanner,
    private readonly asr: MutableASRProvider,
    private readonly tts: MutableTTSProvider,
    private readonly settings: MobileProviderSettings,
    private readonly http: AuditedMobileHttpAdapter,
    private readonly primitives: RuntimePrimitives,
  ) {}

  createProject(name: string) { return this.core.createProject(name); }
  async importVideo(projectId: string) { const picked = await this.native.pickVideo(); if (!picked) return undefined; return this.core.importVideo(projectId, picked.sourceUri); }

  connectProvider(config: ProviderConfig, apiKey?: string) { return this.configurePlanner(config, apiKey); }
  async configurePlanner(config: ProviderConfig, apiKey?: string, providerFactory?: (config: ProviderConfig, credential?: string) => LLMProvider) {
    if (!["openai", "openai-compatible", "custom"].includes(config.kind) && !providerFactory) throw new Error(`${config.kind} planner implementation is not included on mobile`);
    const saved = await this.settings.saveToSlot("planner", config, apiKey);
    const credential = saved.credentialRef ? await this.settings.credential(saved.credentialRef) : undefined;
    const provider = providerFactory?.(saved, credential) ?? new OpenAILLMProvider(saved.model, credential, saved.baseUrl, 120_000, this.http, this.primitives, saved.reasoning);
    this.planner.set(provider); this.plannerConfig = saved;
    return { config: saved, health: await provider.health?.() };
  }

  async configureASR(config: ProviderConfig, apiKey?: string) {
    if (!this.speechNative) throw new Error("NativeSpeechHost is not installed; large media must never fall back to JS/base64 upload");
    assertOfficialSpeechConfig(config, "ASR");
    if (config.model !== "gpt-4o-transcribe-diarize" && config.model !== "whisper-1") throw new Error("Mobile ASR requires gpt-4o-transcribe-diarize or whisper-1 so edits always have timestamps");
    const saved = await this.settings.saveToSlot("asr", config, apiKey);
    const credential = saved.credentialRef ? await this.settings.credential(saved.credentialRef) : undefined;
    const provider = new MobileOpenAIASRProvider(saved.model as MobileOpenAIASRModel, credential, this.speechNative, this.http, saved.baseUrl);
    this.asr.set(provider);
    return { config: saved, health: await provider.health() };
  }

  async configureTTS(config: ProviderConfig, apiKey?: string) {
    assertOfficialSpeechConfig(config, "TTS");
    const saved = await this.settings.saveToSlot("tts", config, apiKey);
    const credential = saved.credentialRef ? await this.settings.credential(saved.credentialRef) : undefined;
    const provider = new MobileOpenAITTSProvider(saved.model, credential, this.http, saved.baseUrl);
    this.tts.set(provider);
    return { config: saved, health: await provider.health() };
  }

  private async restoreSlot(slot: MobileProviderSlot) {
    const saved = await this.settings.configForSlot(slot); if (!saved) return;
    const credential = saved.credentialRef ? await this.settings.credential(saved.credentialRef) : undefined;
    if (slot === "planner") {
      if (!["openai", "openai-compatible", "custom"].includes(saved.kind)) throw new Error(`${saved.kind} planner implementation is not included on mobile`);
      this.planner.set(new OpenAILLMProvider(saved.model, credential, saved.baseUrl, 120_000, this.http, this.primitives, saved.reasoning)); this.plannerConfig = saved; return;
    }
    if (slot === "asr") {
      if (!this.speechNative) throw new Error("NativeSpeechHost is not installed");
      assertOfficialSpeechConfig(saved, "ASR");
      if (saved.model !== "gpt-4o-transcribe-diarize" && saved.model !== "whisper-1") throw new Error("Saved ASR configuration is not supported by this mobile build");
      this.asr.set(new MobileOpenAIASRProvider(saved.model as MobileOpenAIASRModel, credential, this.speechNative, this.http, saved.baseUrl)); return;
    }
    assertOfficialSpeechConfig(saved, "TTS"); this.tts.set(new MobileOpenAITTSProvider(saved.model, credential, this.http, saved.baseUrl));
  }

  async restoreProviderSlots() {
    const errors: Array<{ slot: MobileProviderSlot; message: string }> = [];
    for (const slot of ["planner", "asr", "tts"] as const) {
      try { await this.restoreSlot(slot); }
      catch (error) { errors.push({ slot, message: error instanceof Error ? error.message : String(error) }); }
    }
    return errors;
  }

  async providerHealth() { return { planner: await this.planner.health(), asr: await this.asr.health(), tts: await this.tts.health() }; }
  transcribe(projectId: string, assetId: string, options: { language?: string; prompt?: string } = {}) { return this.core.transcribe(projectId, assetId, options); }
  listVoices(projectId: string) { return this.core.listVoices(projectId); }
  addNarration(projectId: string, input: { text: string; voiceId: string; language: string; timelineInUs: number; targetDurationUs?: number; actionOnOverflow?: "extend" | "fail" }) { return this.core.addNarration(projectId, input); }

  async proposeEdit(projectId: string, assetId: string, prompt: string, targetDurationUs = 30_000_000) {
    let transcript: Transcript; try { transcript = await this.core.readTranscript(projectId); } catch { transcript = await this.core.transcribe(projectId, assetId, { language: "zh" }); }
    if (!this.plannerConfig) throw new Error("Configure a planner before remote planning");
    this.lastPrivacy = (await buildMobileContextPack(this.primitives, { projectId, provider: this.plannerConfig, approvedAt: this.primitives.clock.now().toISOString(), transcript })).evidence;
    return this.core.proposeStrategy(projectId, prompt, targetDurationUs);
  }
  async approveProposal(projectId: string, strategyId: string) { const strategy = await this.core.approveStrategy(projectId, strategyId); const plan = await this.core.createEditPlan(projectId); const validation = await this.core.validatePlan(projectId, plan.id); if (!validation.valid) throw new Error(`EditPlan rejected: ${validation.issues.map((item) => item.message).join("; ")}`); const version = await this.core.applyPlan(projectId, plan.id); return { strategy, plan, validation, version }; }
  renderPreview(projectId: string, range?: { startUs: number; endUs: number }) { return this.core.renderPreview(projectId, range); }
  submitFeedback(projectId: string, message: string, range?: { startUs: number; endUs: number }) { return this.core.submitFeedback(projectId, message, { ...(range ? { range } : {}) }); }
  async applyPatch(projectId: string) {
    if (this.plannerConfig) { const [transcript, timeline, feedback] = await Promise.all([this.core.readTranscript(projectId), this.core.store.readTimeline(projectId), this.core.store.listFeedback(projectId)]); this.lastPrivacy = (await buildMobileContextPack(this.primitives, { projectId, provider: this.plannerConfig, approvedAt: this.primitives.clock.now().toISOString(), transcript, timeline, feedback })).evidence; }
    const patch = await this.core.createPatch(projectId); const validation = await this.core.validatePatch(projectId, patch.id); if (!validation.valid) throw new Error(`EditPatch rejected: ${validation.issues.map((item) => item.message).join("; ")}`); return { patch, version: await this.core.applyPatch(projectId, patch.id) };
  }
  listVersions(projectId: string) { return this.core.listVersions(projectId); }
  restoreVersion(projectId: string, version: number) { return this.core.restoreVersion(projectId, version); }
  async exportVideo(projectId: string) { await this.core.approveFinal(projectId); return this.core.exportVideo(projectId); }
  listJobs(projectId: string) { return this.core.listJobs(projectId); }
  cancelJob(projectId: string, jobId: string) { return this.core.cancelJob(projectId, jobId); }
  status(projectId: string) { return this.core.status(projectId); }
  privacyEvidence() { return this.lastPrivacy; }
  networkAudit() { return [...this.http.records]; }
}

export async function createMobileHost(native: NativeVideoHostBridge, speechNative?: NativeSpeechHostBridge): Promise<MobileHostComposition> {
  const { profile } = await createNativeHostProfile(native);
  const budget = profile.capabilities.resourceBudget;
  const repository = new MobileProjectRepository(profile.filesystem, native, profile.primitives.clock, profile.primitives.ids, profile.primitives.crypto);
  const providerSettings = new MobileProviderSettings(profile.filesystem, profile.secureStorage);
  const planner = new MutablePlanner(); const asr = new MutableASRProvider(); const tts = new MutableTTSProvider();
  const auditedHttp = new AuditedMobileHttpAdapter(profile.http);
  const platform = await native.platform();
  const renderer = new NativeMobileRenderer(native, { platform, previewMaxWidth: budget.previewMaxWidth, createId: () => profile.primitives.ids.create() });
  const core = new VideoAgentCore(
    repository,
    { asr, tts, planner, renderer, mediaProbe: { probe: (uri) => native.probe(uri as never) }, previewSelfCheck: createMobilePreviewSelfCheck(native) },
    { maxUploadBytes: Math.max(256 * 1024 * 1024, budget.maxWorkingSetBytes * 4), maxPreviewDurationUs: budget.previewMaxDurationUs, maxConcurrentJobs: 1, maxFfmpegProcesses: 1, maxAsrJobs: 1, maxGpuJobs: 1 },
    new StructuredLogger("error"), profile.primitives, profile.background,
  );
  const facade = new VideoAgentFacade(core, native, speechNative, planner, asr, tts, providerSettings, auditedHttp, profile.primitives);
  await core.jobs.recover();
  const providerRestoreErrors = await facade.restoreProviderSlots();
  return { core, facade, repository, providerSettings, profile, providerRestoreErrors };
}
