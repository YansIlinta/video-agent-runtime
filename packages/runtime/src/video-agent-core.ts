import { WorkflowEngine } from "../../core/src/workflow.js";
import { createOperation, diffTimelines, timelineFromPlan, validateEditPlan } from "../../core/src/edit-engine.js";
import { diagnoseFeedback, normalizeFeedback } from "../../core/src/feedback.js";
import { timelineFromPatch, validateEditPatch } from "../../core/src/patch-engine.js";
import { transcriptToTimelineMarkdown } from "../../core/src/timeline-context.js";
import type { EditPlan, EditPatch, EditingStrategy, Feedback, ProjectVersion, VoiceProfile, VoiceDesignRequest, EditPatchOperation, Transcript } from "../../core/src/schemas.js";
import type { ProjectRepository } from "../../core/src/repository.js";
import { SystemClock, WebCryptoAdapter, WebIdAdapter } from "../../platform/src/portable.js";
import type { BackgroundExecutionAdapter, RuntimePrimitives } from "../../platform/src/contracts.js";
// Import the specific contract module, not the providers barrel: the barrel re-exports Node-only
// implementations (fakes, openai-voice, registry → node-host) into every consuming host graph.
import type { AlignmentProvider, ASRProvider, DiarizationProvider, LLMProvider, OperationContext, Renderer, TTSProvider, VisualEvidenceProvider, VoiceProvider } from "../../providers/src/contracts.js";
import { DurableJobQueue } from "../../jobs/src/index.js";
import { StructuredLogger } from "./logger.js";
import { analyzeVoiceReference, asrCacheKey, assertVoiceAuthorized, fitSpeechToRange, fitTtsToRange, fuseTranscript, normalizeAsrResult, synthesizeSpeech } from "./portable-services.js";
import { selectVoiceReference } from "./voice-reference-selection.js";

export interface RuntimeProviders {
  asr: ASRProvider;
  tts: TTSProvider;
  planner: LLMProvider;
  renderer: Renderer;
  alignment?: AlignmentProvider;
  diarization?: DiarizationProvider;
  visual?: VisualEvidenceProvider;
  voice?: VoiceProvider;
  mediaProbe?: { probe(uri: string, context?: OperationContext): Promise<import("../../core/src/schemas.js").Asset["metadata"]> };
  previewSelfCheck?: (outputPath: string, timeline: import("../../core/src/schemas.js").Timeline, renderedDurationUs?: number) => Promise<{ passed: boolean; warnings: string[] }>;
}

export interface RuntimeLimits { maxUploadBytes: number; maxInputDurationUs?: number; maxPreviewDurationUs?: number; maxDiskBytesPerProject?: number; maxRetainedPreviews?: number; maxConcurrentJobs?: number; maxFfmpegProcesses?: number; maxAsrJobs?: number; maxGpuJobs?: number; jobMaxAttempts?: number; baseRetryMs?: number }
function contextCancelled(error: unknown) { return /abort|cancel/iu.test(error instanceof Error ? `${error.name} ${error.message}` : String(error)); }
function publicVoiceProfile(profile: VoiceProfile) { const { providerVoiceId: _providerVoiceId, providerMetadata: _providerMetadata, consent, ...safe } = profile; return { ...safe, ...(consent ? { consent: { grantedBy: consent.grantedBy, grantedAt: consent.grantedAt, scope: consent.scope, ...(consent.expiresAt ? { expiresAt: consent.expiresAt } : {}) } } : {}) }; }

export class VideoAgentCore {
  readonly workflow: WorkflowEngine;
  readonly jobs: DurableJobQueue;

  private readonly primitives: RuntimePrimitives;
  constructor(readonly store: ProjectRepository, readonly providers: RuntimeProviders, readonly limits: RuntimeLimits = { maxUploadBytes: 5 * 1024 * 1024 * 1024 }, readonly logger = new StructuredLogger("error"), primitives?: RuntimePrimitives, background?: BackgroundExecutionAdapter) {
    this.primitives = primitives ?? { clock: new SystemClock(), ids: new WebIdAdapter(), crypto: new WebCryptoAdapter() };
    this.workflow = new WorkflowEngine(store, this.primitives.clock, this.primitives.ids);
    this.jobs = new DurableJobQueue(store, { concurrency: limits.maxConcurrentJobs ?? 2, maxAttempts: limits.jobMaxAttempts ?? 3, baseRetryMs: limits.baseRetryMs ?? 250, typeConcurrency: { "preview-render": limits.maxFfmpegProcesses ?? 1, "final-render": limits.maxFfmpegProcesses ?? 1, asr: limits.maxAsrJobs ?? 1, alignment: limits.maxGpuJobs ?? 1, diarization: limits.maxGpuJobs ?? 1, "voice-reference-analysis": limits.maxGpuJobs ?? 1, "voice-enroll": limits.maxGpuJobs ?? 1, "voice-design": limits.maxGpuJobs ?? 1, tts: limits.maxGpuJobs ?? 1, dubbing: limits.maxGpuJobs ?? 1, "align-generated-speech": limits.maxGpuJobs ?? 1 } }, this.primitives.clock, this.primitives.ids, background);
    this.jobs.register("asr", async (job, context) => { const input = job.input as { assetId: string; options?: { language?: string; prompt?: string } }; return this.transcribe(job.projectId, input.assetId, input.options ?? {}, context); });
    this.jobs.register("alignment", async (job, context) => this.enrichTranscript(job.projectId, context));
    this.jobs.register("diarization", async (job, context) => this.enrichTranscript(job.projectId, context));
    this.jobs.register("visual-analysis", async (job, context) => { const input = job.input as { startUs: number; endUs: number }; return this.inspectVisualRange(job.projectId, input.startUs, input.endUs, context); });
    this.jobs.register("preview-render", async (job, context) => { const input = job.input as { range?: { startUs: number; endUs: number } }; return this.renderPreview(job.projectId, input.range, context); });
    this.jobs.register("final-render", async (job, context) => this.exportVideo(job.projectId, context));
    this.jobs.register("tts", async (job, context) => this.addNarration(job.projectId, job.input as Parameters<VideoAgentCore["addNarration"]>[1], context));
    this.jobs.register("voice-reference-analysis", async (job) => this.analyzeVoiceReference(job.projectId, (job.input as { assetId: string; speakerId?: string }).assetId, (job.input as { speakerId?: string }).speakerId));
    this.jobs.register("voice-enroll", async (job, context) => this.enrollVoice(job.projectId, job.input as Parameters<VideoAgentCore["enrollVoice"]>[1], context));
    this.jobs.register("voice-design", async (job, context) => this.designVoice(job.projectId, job.input as VoiceDesignRequest, context));
    this.jobs.register("voice-preview", async (job, context) => { const input = job.input as { voiceProfileId: string; text: string; language: string }; return this.generateSpeech(job.projectId, input, context); });
    this.jobs.register("dubbing", async (job, context) => this.generateDubbing(job.projectId, job.input as Parameters<VideoAgentCore["generateDubbing"]>[1], context));
    this.jobs.register("align-generated-speech", async (job, context) => this.alignGeneratedSpeech(job.projectId, (job.input as { speechAssetId: string }).speechAssetId, context));
    this.jobs.register("llm-strategy", async (job, context) => { const input = job.input as { prompt: string; targetDurationUs: number }; return this.proposeStrategy(job.projectId, input.prompt, input.targetDurationUs, context); });
    this.jobs.register("llm-edit-plan", async (job, context) => this.createEditPlan(job.projectId, undefined, context));
    this.jobs.register("llm-patch-plan", async (job, context) => this.createPatch(job.projectId, undefined, context));
  }

  private id() { return this.primitives.ids.create(); }
  private now() { return this.primitives.clock.now().toISOString(); }

  createProject(name: string) {
    return this.store.create(name);
  }

  enqueueJob(projectId: string, type: import("../../core/src/schemas.js").Job["type"], input: unknown, idempotencyKey?: string) { return this.jobs.enqueue(projectId, type, input, idempotencyKey); }
  jobStatus(projectId: string, jobId: string) { return this.jobs.status(projectId, jobId); }
  listJobs(projectId: string) { return this.jobs.list(projectId); }
  cancelJob(projectId: string, jobId: string) { return this.jobs.cancel(projectId, jobId); }

  private voiceProvider(): VoiceProvider {
    const provider = this.providers.voice;
    if (!provider) throw new Error("Configured TTS provider does not expose voice identity capabilities");
    return provider;
  }

  voiceCapabilities() { const provider = this.providers.voice; return provider ? { provider: provider.id, model: provider.model, capabilities: provider.voiceCapabilities() } : { provider: this.providers.tts.id, model: this.providers.tts.model, capabilities: { tts: true, presetVoices: true, voiceDesign: false, zeroShotClone: false, persistentVoiceProfile: false, crossLingualClone: false, voiceConversion: false, streaming: this.providers.tts.capabilities().streaming, wordTimestamps: this.providers.tts.capabilities().timestamps, emotionControl: false, styleControl: this.providers.tts.capabilities().styleControl, remoteDeletion: false } }; }

  voiceModels() { return [{ provider: this.providers.tts.id, model: this.providers.tts.model, active: true, capabilities: this.voiceCapabilities().capabilities }]; }

  async listVoices(projectId: string) { const [persisted, presets] = await Promise.all([this.store.listVoiceProfiles(projectId), this.providers.tts.listVoices?.() ?? []]); return [...presets.filter((preset) => !persisted.some((item) => item.id === preset.id)), ...persisted].map(publicVoiceProfile); }

  analyzeVoiceReference(projectId: string, assetId: string, speakerId?: string) { return analyzeVoiceReference(this.primitives, this.store, projectId, assetId, speakerId); }

  async enrollVoice(projectId: string, input: { assetId: string; name: string; languages: string[]; authorizationConfirmed: boolean; grantedBy: string; evidence: string; scope?: string; speakerId?: string; providerAuthorizationId?: string; allowEmbeddingOnly?: boolean }, context?: OperationContext) {
    if (!input.authorizationConfirmed || !input.evidence.trim()) throw new Error("Unauthorized voice enrollment rejected: explicit confirmation and evidence are required");
    const provider = this.voiceProvider(); const capabilities = provider.voiceCapabilities();
    if (!capabilities.zeroShotClone || !provider.enrollVoice) throw new Error(`Provider ${provider.id} does not support authorized voice cloning`);
    const [project, quality] = await Promise.all([this.store.readProject(projectId), this.analyzeVoiceReference(projectId, input.assetId, input.speakerId)]);
    const asset = project.assets.find((item) => item.id === input.assetId); if (!asset) throw new Error(`Unknown asset ${input.assetId}`);
    if (quality.speechDurationUs < 3_000_000 || quality.usableSpeechPercentage < 20) throw new Error("Voice reference quality is insufficient for enrollment");

    const referencePolicy = provider.cloneReferencePolicy?.();
    let reference;
    if (referencePolicy && project.activeTranscriptId) {
      const transcript = await this.store.readTranscript(projectId, project.activeTranscriptId);
      if (transcript.assetId === asset.id) reference = selectVoiceReference(transcript, quality, input.speakerId, referencePolicy);
    }
    if (referencePolicy?.highQualityRequiresReferenceText && !reference && !input.allowEmbeddingOnly) throw new Error("High-quality voice enrollment requires a clean transcript-backed reference range; transcribe/align the source first or explicitly opt into embedding-only cloning");
    if (input.allowEmbeddingOnly && referencePolicy && !referencePolicy.embeddingOnlySupported) throw new Error(`Provider ${provider.id} does not support embedding-only voice enrollment`);

    const now = this.now();
    const enrollmentDurationUs = reference ? reference.endUs - reference.startUs : quality.speechDurationUs;
    const result = await this.voiceCall(projectId, "voice-enroll", () => provider.enrollVoice!({
      name: input.name,
      referencePath: this.store.resolveProjectFile(projectId, asset.relativePath),
      referenceAssetId: asset.id,
      languages: input.languages,
      ...(reference ? { referenceText: reference.referenceText, referenceRangeSeconds: { start: reference.startUs / 1_000_000, end: reference.endUs / 1_000_000 } } : {}),
      ...(input.allowEmbeddingOnly ? { allowEmbeddingOnly: true } : {}),
      ...(input.providerAuthorizationId ? { providerAuthorizationId: input.providerAuthorizationId } : {}),
      authorization: { grantedBy: input.grantedBy, grantedAt: now, evidence: input.evidence, scope: input.scope ?? "project" },
    }, context), { inputDurationUs: enrollmentDurationUs });
    const referenceProvenance = reference ? { mode: "transcript-backed", startUs: reference.startUs, endUs: reference.endUs, segmentIds: reference.segmentIds, ...(reference.speakerId ? { speakerId: reference.speakerId } : {}), score: reference.score } : { mode: input.allowEmbeddingOnly ? "embedding-only-explicit" : "provider-managed" };
    const profile: VoiceProfile = { id: this.id(), type: "cloned", provider: provider.id, providerVoiceId: result.providerVoiceId, model: result.model, name: input.name, languages: input.languages, cloning: true, status: "preview", referenceAssetIds: [asset.id], authorizationStatus: "authorized", createdAt: now, consent: { grantedBy: input.grantedBy, grantedAt: now, evidence: input.evidence, scope: input.scope ?? "project" }, usageRestrictions: ["Use only within recorded authorization scope", "Generated speech must be disclosed as synthetic"], providerMetadata: { ...(result.providerMetadata ?? {}), reference: referenceProvenance } };
    if (result.derivedRepresentation) await this.store.writeProjectFile(projectId, `voices/derived/${profile.id}.bin`, result.derivedRepresentation, true);
    await this.store.writeVoiceProfile(projectId, profile); return { profile: publicVoiceProfile(profile), quality, reference: referenceProvenance, requiresApproval: true };
  }

  async approveVoice(projectId: string, voiceProfileId: string) { const profile = await this.store.readVoiceProfile(projectId, voiceProfileId); if (profile.status !== "preview") throw new Error("VoiceProfile is not awaiting preview approval"); assertVoiceAuthorized({ ...profile, status: "active" }); const active = { ...profile, status: "active" as const }; await this.store.writeVoiceProfile(projectId, active); return publicVoiceProfile(active); }

  async previewVoice(projectId: string, input: { voiceProfileId: string; text: string; language: string }, context?: OperationContext) { const profile = await this.store.readVoiceProfile(projectId, input.voiceProfileId); if (profile.status !== "preview" && profile.status !== "active") throw new Error("VoiceProfile is not available for preview"); if (profile.type === "cloned" && profile.authorizationStatus !== "authorized") throw new Error("Unauthorized voice preview rejected"); const speech = await synthesizeSpeech(this.primitives, this.store, projectId, this.providers.tts, { text: input.text, voiceId: profile.providerVoiceId, language: input.language, voiceProfile: { ...profile, status: "active" } }, context); await this.registerSpeechAsset(projectId, speech); return { speechAssetId: speech.id, durationUs: speech.durationUs, wordTimings: speech.wordTimings, requiresApproval: profile.status === "preview" }; }

  async designVoice(projectId: string, input: VoiceDesignRequest, context?: OperationContext) { const provider = this.voiceProvider(); if (!provider.voiceCapabilities().voiceDesign || !provider.designVoice) throw new Error(`Provider ${provider.id} does not support voice design`); const result = await this.voiceCall(projectId, "voice-design", () => provider.designVoice!(input, context), { outputDuration: (value) => Math.round(value.sample.durationSeconds * 1_000_000) }); const now = this.now(); const profile: VoiceProfile = { id: this.id(), type: "designed", provider: provider.id, providerVoiceId: result.providerVoiceId, model: result.model, name: input.description.slice(0, 80), languages: [input.language], cloning: false, status: "preview", referenceAssetIds: [], authorizationStatus: "not_required", createdAt: now, usageRestrictions: ["Disclose as synthetic voice"], providerMetadata: result.providerMetadata ?? {} }; await this.store.writeVoiceProfile(projectId, profile); return { profile: publicVoiceProfile(profile), sample: { durationUs: Math.round(result.sample.durationSeconds * 1_000_000), sampleRate: result.sample.sampleRate }, requiresApproval: true }; }

  async deleteVoice(projectId: string, voiceProfileId: string, context?: OperationContext) { return this.store.withLock(projectId, async () => { const profile = await this.store.readVoiceProfile(projectId, voiceProfileId); let remoteDeletion: "requested" | "unsupported" | "failed" | "not_applicable" = "not_applicable"; if (this.providers.voice?.deleteVoice && profile.providerVoiceId) { try { await this.providers.voice.deleteVoice(profile.providerVoiceId, context); remoteDeletion = "requested"; } catch { remoteDeletion = "failed"; } } else if (profile.type === "cloned") remoteDeletion = "unsupported"; await this.store.removeProjectFile(projectId, `voices/derived/${profile.id}.bin`); const speech = (await this.store.listSpeechAssets(projectId)).filter((item) => item.voiceProfileId === profile.id); for (const item of speech) { await this.store.removeProjectFile(projectId, `derived/${item.id}.wav`); await this.store.removeProjectFile(projectId, `speech/${item.id}.json`); } const deleted = { ...profile, status: "deleted" as const, authorizationStatus: profile.authorizationStatus === "authorized" ? "revoked" as const : profile.authorizationStatus, providerMetadata: {} }; await this.store.writeVoiceProfile(projectId, deleted); const event = { id: this.id(), projectId, voiceProfileId, localReferencesRemoved: false, derivedRepresentationsRemoved: true, cachesInvalidated: true, remoteDeletion, createdAt: this.now() }; await this.store.writeVoiceDeletionEvent(projectId, event); return event; }); }

  async generateSpeech(projectId: string, input: { voiceProfileId: string; text: string; language: string; speed?: number; speechType?: "tts" | "designed_voice" | "cloned_voice" | "translated_dub"; sourceSegmentIds?: string[] }, context?: OperationContext) { const profile = await this.store.readVoiceProfile(projectId, input.voiceProfileId); assertVoiceAuthorized(profile); return this.voiceCall(projectId, "tts-generate", () => synthesizeSpeech(this.primitives, this.store, projectId, this.providers.tts, { text: input.text, voiceId: profile.providerVoiceId, language: input.language, ...(input.speed ? { speed: input.speed } : {}), voiceProfile: profile, ...(input.speechType ? { speechType: input.speechType } : {}), sourceSegmentIds: input.sourceSegmentIds ?? [] }, context), { outputDuration: (value) => value.durationUs }); }

  fitSpeech(durationUs: number, targetDurationUs: number, options?: Parameters<typeof fitSpeechToRange>[2]) { return fitSpeechToRange(durationUs, targetDurationUs, options); }

  async alignGeneratedSpeech(projectId: string, speechAssetId: string, context?: OperationContext) {
    const speech = await this.store.readSpeechAsset(projectId, speechAssetId); if (!this.providers.alignment) return { speech, fallback: true, warning: "Alignment provider is not configured; deterministic estimated timings retained" };
    const transcript: Transcript = { schemaVersion: 1, id: `generated-${speech.id}`, assetId: speech.assetId, provider: speech.provider, model: speech.model, language: speech.language, rawTranscript: speech.text, normalizedTranscript: speech.text.normalize("NFKC"), displayTranscript: speech.text.normalize("NFKC"), words: speech.wordTimings, segments: [{ id: `generated-segment-${speech.id}`, startUs: 0, endUs: speech.durationUs, language: speech.language, rawText: speech.text, normalizedText: speech.text.normalize("NFKC"), displayText: speech.text.normalize("NFKC"), wordIds: speech.wordTimings.map((word) => word.id) }], speakers: [], silenceRegions: [], quality: { lowConfidenceWordIds: [], unmappedWordIds: [], failedAlignmentSegmentIds: [], speakerOverlapRanges: [], unknownLanguageSegmentIds: [], musicHeavyRanges: [], longSilenceRanges: [], warnings: [] }, cacheKey: speech.cacheKey, createdAt: speech.createdAt };
    const result = await this.providers.alignment.align(this.store.resolveProjectFile(projectId, `derived/${speech.id}.wav`), transcript, context); const words = speech.wordTimings.map((word, index) => result.words[index] ? { ...word, startUs: result.words[index]!.startUs, endUs: result.words[index]!.endUs, confidence: result.words[index]!.confidence, timingSource: "aligned" as const } : word); const aligned = { ...speech, wordTimings: words }; await this.store.writeSpeechAsset(projectId, aligned); return { speech: aligned, fallback: false, warnings: result.warnings };
  }

  private async registerSpeechAsset(projectId: string, speech: Awaited<ReturnType<VideoAgentCore["generateSpeech"]>>) {
    const project = await this.store.readProject(projectId); if (project.assets.some((item) => item.id === speech.assetId)) return;
    const relativePath = `derived/${speech.id}.wav`; const bytes = await this.store.readProjectFile(projectId, relativePath);
    await this.store.writeProject({ ...project, assets: [...project.assets, { id: speech.assetId, kind: "tts", originalName: `${speech.id}.wav`, relativePath, ref: { uri: `project://${projectId}/${relativePath}`, storageClass: "durable", mediaType: "audio/wav", displayName: `${speech.id}.wav` }, sha256: await this.primitives.crypto.sha256(bytes), metadata: { durationUs: speech.durationUs, audioCodec: "pcm_s16le", sampleRate: speech.sampleRate, channels: 1, sizeBytes: bytes.byteLength }, createdAt: speech.createdAt, provenance: { provider: speech.provider, model: speech.model, sourceAssetIds: [] } }] });
  }

  async replaceSpeech(projectId: string, input: { startUs: number; endUs: number; replacementText: string; voiceProfileId?: string; language: string; mode?: "auto" | "caption-only" | "audio"; allowExtend?: boolean }, context?: OperationContext) {
    const [project, timeline] = await Promise.all([this.store.readProject(projectId), this.store.readTimeline(projectId)]); if (!project.activeEditPlanId) throw new Error("Speech replacement requires an active EditPlan");
    await this.workflow.move(projectId, "PROCESSING_FEEDBACK", { kind: "speech-replacement", range: { startUs: input.startUs, endUs: input.endUs } });
    const caption = timeline.tracks.find((track) => track.type === "caption")?.clips.find((clip) => clip.timelineOutUs > input.startUs && clip.timelineInUs < input.endUs);
    const audioRequired = input.mode === "audio" || (input.mode !== "caption-only" && Boolean(input.voiceProfileId));
    const feedbackId = this.id(); await this.store.writeFeedback(projectId, { id: feedbackId, projectId, version: project.activeVersion, category: audioRequired ? "tts" : "caption", rawMessage: input.replacementText, message: input.replacementText, range: { startUs: input.startUs, endUs: input.endUs }, severity: "high", createdAt: this.now() });
    const operations: EditPatchOperation[] = [];
    let speech; let fit;
    if (audioRequired) {
      if (!input.voiceProfileId) throw new Error("Audio replacement requires an authorized VoiceProfile");
      speech = await this.generateSpeech(projectId, { voiceProfileId: input.voiceProfileId, text: input.replacementText, language: input.language }, context);
      fit = fitSpeechToRange(speech.durationUs, input.endUs - input.startUs, input.allowExtend === undefined ? {} : { allowExtend: input.allowExtend });
      if (fit.action === "ASK_USER" || fit.action === "REWRITE_SHORTER" || fit.action === "REPLAN_SURROUNDING_EDIT") throw new Error(`Speech replacement requires ${fit.action}`);
      if (fit.action === "ADJUST_RATE") speech = await this.generateSpeech(projectId, { voiceProfileId: input.voiceProfileId, text: input.replacementText, language: input.language, speed: fit.allowedRate }, context);
      await this.registerSpeechAsset(projectId, speech);
      const timelineOutUs = fit.action === "EXTEND_TIMELINE" ? input.startUs + speech.durationUs : input.endUs;
      operations.push({ type: "insertAudioClip", trackId: "tts-replacement", clip: { id: `speech-replacement-${this.id()}`, type: "audio", assetId: speech.assetId, sourceInUs: 0, sourceOutUs: speech.durationUs, timelineInUs: input.startUs, timelineOutUs, speed: 1, gainDb: 0, transcriptWordIds: speech.wordTimings.map((word) => word.id), metadata: { speechAssetId: speech.id, voiceProfileId: input.voiceProfileId, replacesOriginalRange: { startUs: input.startUs, endUs: input.endUs }, generated: true } }, reason: "Insert authorized generated replacement through Timeline" });
    }
    if (caption) operations.push({ type: "replaceCaptionText", clipId: caption.id, text: input.replacementText, ...(speech ? { speechAssetId: speech.id } : {}), reason: "Keep caption synchronized with corrected speech" });
    if (!operations.length) throw new Error("No caption or audio replacement target was found");
    const patch: EditPatch = { schemaVersion: 1, id: this.id(), projectId, basedOnVersion: project.activeVersion, feedbackIds: [feedbackId], scope: { timelineRanges: [{ startUs: input.startUs, endUs: input.endUs }], segmentIds: caption ? [caption.id] : [], trackIds: ["tts-replacement"] }, reason: `Speech replacement: ${input.replacementText}`, operations, createdAt: this.now() };
    await this.store.writeEditPatch(projectId, patch); await this.workflow.move(projectId, "PATCHING", { patchId: patch.id }); const validation = await this.validatePatch(projectId, patch.id); if (!validation.valid) throw new Error(`Speech replacement patch invalid: ${validation.issues.map((item) => item.message).join("; ")}`); const diff = await this.diffPatch(projectId, patch.id); const version = await this.applyPatch(projectId, patch.id); await this.workflow.move(projectId, "WAITING_REVIEW", { version: version.version }); return { classification: audioRequired ? "audio-replacement" : "caption-only", speech, fit, patch, validation, diff, version, requiresReview: true };
  }

  async generateDubbing(projectId: string, input: { language: string; segments: Array<{ sourceSegmentId: string; translatedText: string; voiceProfileId: string }>; allowExtend?: boolean }, context?: OperationContext) {
    const [project, timeline, transcript] = await Promise.all([this.store.readProject(projectId), this.store.readTimeline(projectId), this.readTranscript(projectId)]); if (!project.activeEditPlanId) throw new Error("Dubbing requires an active EditPlan");
    await this.workflow.move(projectId, "PROCESSING_FEEDBACK", { kind: "dubbing", language: input.language });
    const operations: EditPatchOperation[] = []; const speechAssets = []; const ranges: Array<{ startUs: number; endUs: number }> = [];
    for (const item of input.segments) {
      const source = transcript.segments.find((segment) => segment.id === item.sourceSegmentId); if (!source) throw new Error(`Unknown transcript segment ${item.sourceSegmentId}`);
      const profile = await this.store.readVoiceProfile(projectId, item.voiceProfileId); assertVoiceAuthorized(profile); if (profile.type === "cloned" && !this.voiceProvider().voiceCapabilities().crossLingualClone && !profile.languages.includes(input.language)) throw new Error(`Provider does not support cross-lingual cloning for ${profile.id}`);
      let speech = await this.generateSpeech(projectId, { voiceProfileId: profile.id, text: item.translatedText, language: input.language, speechType: "translated_dub", sourceSegmentIds: [source.id] }, context); const fit = fitSpeechToRange(speech.durationUs, source.endUs - source.startUs, input.allowExtend === undefined ? {} : { allowExtend: input.allowExtend }); if (fit.action === "ADJUST_RATE") speech = await this.generateSpeech(projectId, { voiceProfileId: profile.id, text: item.translatedText, language: input.language, speed: fit.allowedRate, speechType: "translated_dub", sourceSegmentIds: [source.id] }, context); if (["ASK_USER", "REWRITE_SHORTER", "REPLAN_SURROUNDING_EDIT"].includes(fit.action)) throw new Error(`Dubbing segment ${source.id} requires ${fit.action}`); await this.registerSpeechAsset(projectId, speech); speechAssets.push(speech); ranges.push({ startUs: source.startUs, endUs: source.endUs }); operations.push({ type: "insertAudioClip", trackId: `dubbing-${input.language}`, clip: { id: `dub-${this.id()}`, type: "audio", assetId: speech.assetId, sourceInUs: 0, sourceOutUs: speech.durationUs, timelineInUs: source.startUs, timelineOutUs: fit.action === "EXTEND_TIMELINE" ? source.startUs + speech.durationUs : source.endUs, speed: 1, gainDb: 0, transcriptWordIds: speech.wordTimings.map((word) => word.id), metadata: { sourceSegmentId: source.id, translatedText: item.translatedText, speechAssetId: speech.id, voiceProfileId: profile.id, generated: true } }, reason: "Add translated speech through DubbingTrack" });
      for (const word of speech.wordTimings) operations.push({ type: "insertCaptionClip", trackId: `dubbing-captions-${input.language}`, clip: { id: `dub-caption-${this.id()}`, type: "caption", sourceInUs: word.startUs, sourceOutUs: word.endUs, timelineInUs: source.startUs + word.startUs, timelineOutUs: Math.min(source.endUs, source.startUs + word.endUs), speed: 1, text: word.displayText, transcriptWordIds: [word.id], metadata: { sourceSegmentId: source.id, speechAssetId: speech.id, language: input.language, generated: true } }, reason: "Synchronize translated captions with generated speech" });
    }
    const feedbackId = this.id(); await this.store.writeFeedback(projectId, { id: feedbackId, projectId, version: project.activeVersion, category: "tts", rawMessage: `Generate ${input.language} dubbing`, message: `Generate ${input.language} dubbing`, range: { startUs: Math.min(...ranges.map((range) => range.startUs)), endUs: Math.max(...ranges.map((range) => range.endUs)) }, severity: "high", createdAt: this.now() });
    const patch: EditPatch = { schemaVersion: 1, id: this.id(), projectId, basedOnVersion: project.activeVersion, feedbackIds: [feedbackId], scope: { timelineRanges: ranges, segmentIds: [], trackIds: [`dubbing-${input.language}`, `dubbing-captions-${input.language}`] }, reason: `Generate ${input.language} dubbing`, operations, createdAt: this.now() }; await this.store.writeEditPatch(projectId, patch); await this.workflow.move(projectId, "PATCHING", { patchId: patch.id }); const validation = await this.validatePatch(projectId, patch.id); if (!validation.valid) throw new Error(`Dubbing patch invalid: ${validation.issues.map((item) => item.message).join("; ")}`); const diff = await this.diffPatch(projectId, patch.id); const version = await this.applyPatch(projectId, patch.id); await this.workflow.move(projectId, "WAITING_REVIEW", { version: version.version }); return { speechAssets, patch, validation, diff, version, requiresReview: true };
  }

  private async plannerCall<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    finally { const call = this.providers.planner.takeLastCall?.(projectId); if (call) await this.store.writeProviderCall(projectId, { ...call, projectId }); }
  }

  private async voiceCall<T>(projectId: string, operation: string, action: () => Promise<T>, metrics: { inputDurationUs?: number; outputDuration?: (value: T) => number | undefined } = {}): Promise<T> {
    const started = this.primitives.clock.now().getTime();
    try {
      const value = await action(); const outputDurationUs = metrics.outputDuration?.(value);
      await this.store.writeProviderCall(projectId, { id: this.id(), projectId, operation, provider: this.providers.voice?.id ?? this.providers.tts.id, model: this.providers.voice?.model ?? this.providers.tts.model, latencyMs: this.primitives.clock.now().getTime() - started, retryCount: 0, validation: { valid: true, issues: [] }, status: "succeeded", ...(metrics.inputDurationUs === undefined ? {} : { inputDurationUs: metrics.inputDurationUs }), ...(outputDurationUs === undefined ? {} : { outputDurationUs }), computeMode: (this.providers.voice?.id ?? this.providers.tts.id).includes("openai") ? "remote" : "unknown", createdAt: this.now() });
      return value;
    } catch (error) {
      await this.store.writeProviderCall(projectId, { id: this.id(), projectId, operation, provider: this.providers.voice?.id ?? this.providers.tts.id, model: this.providers.voice?.model ?? this.providers.tts.model, latencyMs: this.primitives.clock.now().getTime() - started, retryCount: 0, validation: { valid: false, issues: [error instanceof Error ? error.message : String(error)] }, status: contextCancelled(error) ? "cancelled" : "failed", computeMode: (this.providers.voice?.id ?? this.providers.tts.id).includes("openai") ? "remote" : "unknown", createdAt: this.now() }); throw error;
    }
  }

  async status(projectId: string) {
    const [project, timeline, workflow] = await Promise.all([this.store.readProject(projectId), this.store.readTimeline(projectId), this.workflow.recover(projectId)]);
    return { project, timeline, workflow };
  }

  async importVideo(projectId: string, sourcePath: string, context?: OperationContext) {
    const sourceName = sourcePath.replace(/\\/gu, "/").split("/").at(-1) ?? "source-video";
    return this.workflow.runStep(projectId, "INGESTING", { sourceName }, async () => this.store.withLock(projectId, async () => {
      const copied = await this.store.copySourceAsset(projectId, sourcePath, this.limits.maxUploadBytes);
      const absolutePath = this.store.resolveProjectFile(projectId, copied.relativePath);
      try {
        if (this.limits.maxDiskBytesPerProject && await this.store.projectDiskUsage(projectId) > this.limits.maxDiskBytesPerProject) throw new Error("Project disk usage quota exceeded");
        if (!this.providers.mediaProbe) throw new Error("Host profile does not provide media probing");
        const metadata = await this.providers.mediaProbe.probe(absolutePath, context);
        if (this.limits.maxInputDurationUs && metadata.durationUs > this.limits.maxInputDurationUs) throw new Error(`Source media exceeds ${this.limits.maxInputDurationUs}us duration quota`);
        const project = await this.store.readProject(projectId);
        const asset = { id: this.id(), kind: "source_video" as const, originalName: sourceName, relativePath: copied.relativePath, ref: { uri: `project://${projectId}/${copied.relativePath}` as const, storageClass: "durable" as const, displayName: sourceName }, sha256: copied.sha256, metadata: { ...metadata, sizeBytes: copied.sizeBytes }, createdAt: this.now() };
        await this.store.writeProject({ ...project, assets: [...project.assets, asset] });
        return asset;
      } catch (error) { await this.store.removeProjectFile(projectId, copied.relativePath); throw error; }
    }));
  }

  async transcribe(projectId: string, assetId: string, options: { language?: string; prompt?: string } = {}, context?: OperationContext) {
    const project = await this.store.readProject(projectId);
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error(`Unknown asset ${assetId}`);
    const key = await asrCacheKey(this.primitives, asset.sha256, this.providers.asr, options);
    const cached = await this.store.findTranscriptByCacheKey(projectId, key);
    if (cached) { await this.store.writeProject({ ...project, activeTranscriptId: cached.id }); context?.onProgress?.(1, "cache-hit", "Reused cached transcript"); return cached; }
    const transcript = await this.workflow.runStep(projectId, "TRANSCRIBING", { assetId, provider: this.providers.asr.id, model: this.providers.asr.model }, async () => {
      const result = await this.providers.asr.transcribe(this.store.resolveProjectFile(projectId, asset.relativePath), options, context);
      const rawResultPath = `analysis/raw/asr-${key}.json`;
      await this.store.writeProjectFile(projectId, rawResultPath, `${JSON.stringify(result, null, 2)}\n`, true);
      const normalized = normalizeAsrResult(this.primitives, asset.id, this.providers.asr, result, key, rawResultPath);
      await this.store.writeTranscript(projectId, normalized);
      await this.store.writeProjectFile(projectId, "analysis/timeline.md", transcriptToTimelineMarkdown(normalized));
      await this.store.writeProject({ ...project, activeTranscriptId: normalized.id });
      return normalized;
    });
    await this.workflow.move(projectId, "READY", { transcriptId: transcript.id });
    return transcript;
  }

  async readTranscript(projectId: string) {
    const project = await this.store.readProject(projectId);
    if (!project.activeTranscriptId) throw new Error("Project has no active transcript");
    return this.store.readTranscript(projectId, project.activeTranscriptId);
  }

  async enrichTranscript(projectId: string, context?: OperationContext) {
    const project = await this.store.readProject(projectId);
    if (!project.activeTranscriptId) throw new Error("Project has no active transcript");
    const transcript = await this.store.readTranscript(projectId, project.activeTranscriptId);
    const asset = project.assets.find((item) => item.id === transcript.assetId);
    if (!asset) throw new Error(`Unknown transcript asset ${transcript.assetId}`);
    const inputPath = this.store.resolveProjectFile(projectId, asset.relativePath);
    let alignment; let diarization;
    const warnings: string[] = [];
    if (this.providers.alignment) { try { alignment = await this.providers.alignment.align(inputPath, transcript, context); } catch (error) { warnings.push(`Alignment unavailable: ${error instanceof Error ? error.message : String(error)}`); } }
    if (this.providers.diarization) { try { diarization = await this.providers.diarization.diarize(inputPath, context); } catch (error) { warnings.push(`Diarization unavailable: ${error instanceof Error ? error.message : String(error)}`); } }
    if (!alignment && !diarization) return { transcript: { ...transcript, quality: { ...transcript.quality, warnings: [...transcript.quality.warnings, ...warnings] } }, fallback: true };
    const fused = fuseTranscript(this.primitives, transcript, alignment, diarization);
    const enriched = { ...fused, quality: { ...fused.quality, warnings: [...fused.quality.warnings, ...warnings] } };
    await this.store.writeTranscript(projectId, enriched);
    await this.store.writeProject({ ...project, activeTranscriptId: enriched.id });
    await this.store.writeProjectFile(projectId, "analysis/timeline.md", transcriptToTimelineMarkdown(enriched));
    return { transcript: enriched, fallback: false };
  }

  async transcriptQuality(projectId: string) { return (await this.readTranscript(projectId)).quality; }

  async inspectVisualRange(projectId: string, startUs: number, endUs: number, context?: OperationContext) {
    if (!this.providers.visual) throw new Error("Visual evidence provider is unavailable");
    if (endUs <= startUs) throw new Error("Visual range must be positive");
    const project = await this.store.readProject(projectId);
    const asset = project.assets.find((item) => item.kind === "source_video");
    if (!asset) throw new Error("No source video asset");
    if (endUs > asset.metadata.durationUs) throw new Error("Visual range exceeds source duration");
    const evidence = await this.providers.visual.inspect({ projectId, assetId: asset.id, inputPath: this.store.resolveProjectFile(projectId, asset.relativePath), outputDirectory: this.store.resolveProjectFile(projectId, "analysis/visual"), range: { startUs, endUs } }, context);
    await this.store.writeVisualEvidence(projectId, evidence);
    return evidence;
  }

  async systemStatus() {
    const checks = await Promise.all([
      this.providers.renderer.health?.() ?? Promise.resolve({ id: this.providers.renderer.id, status: "ready" as const, message: "No active health probe" }),
      this.providers.planner.health?.() ?? Promise.resolve({ id: this.providers.planner.id, status: "ready" as const, message: "Deterministic provider" }),
      this.providers.asr.health?.() ?? Promise.resolve({ id: this.providers.asr.id, status: "ready" as const, message: "Deterministic provider", capabilities: this.providers.asr.capabilities() }),
      this.providers.alignment?.health?.() ?? Promise.resolve({ id: "alignment", status: "unavailable" as const, message: "Not configured" }),
      this.providers.diarization?.health?.() ?? Promise.resolve({ id: "diarization", status: "unavailable" as const, message: "Not configured" }),
      this.providers.tts.health?.() ?? Promise.resolve({ id: this.providers.tts.id, status: "ready" as const, message: "Provider configured", capabilities: this.providers.tts.capabilities() }),
      this.providers.visual?.health?.() ?? Promise.resolve({ id: "visual", status: "unavailable" as const, message: "Not configured" }),
    ]);
    return { ready: checks.every((check) => check.status !== "degraded"), checks, voice: this.voiceCapabilities() };
  }

  async searchTranscript(projectId: string, query: string) {
    const transcript = await this.readTranscript(projectId);
    const needle = query.normalize("NFKC").toLocaleLowerCase();
    return transcript.segments.filter((segment) => segment.normalizedText.toLocaleLowerCase().includes(needle));
  }

  async proposeStrategy(projectId: string, prompt: string, targetDurationUs: number, context?: OperationContext) {
    const strategy = await this.workflow.runStep(projectId, "PROPOSING", { prompt, targetDurationUs }, async () => {
      const transcript = await this.readTranscript(projectId);
      const proposed = await this.plannerCall(projectId, () => this.providers.planner.proposeStrategy({ projectId, prompt, transcript, targetDurationUs }, context));
      await this.store.writeStrategy(projectId, proposed);
      const project = await this.store.readProject(projectId);
      await this.store.writeProject({ ...project, activeStrategyId: proposed.id });
      return proposed;
    });
    await this.workflow.move(projectId, "WAITING_PROPOSAL_APPROVAL", { strategyId: strategy.id });
    return strategy;
  }

  async approveStrategy(projectId: string, strategyId: string) {
    const strategy = await this.store.readStrategy(projectId, strategyId);
    const approved: EditingStrategy = { ...strategy, status: "approved" };
    await this.store.writeStrategy(projectId, approved);
    await this.workflow.move(projectId, "PLANNING", { strategyId });
    return approved;
  }

  async createEditPlan(projectId: string, suppliedPlan?: EditPlan, context?: OperationContext) {
    const project = await this.store.readProject(projectId);
    if (!project.activeStrategyId || !project.activeTranscriptId) throw new Error("Approved strategy and transcript are required");
    const strategy = await this.store.readStrategy(projectId, project.activeStrategyId);
    if (strategy.status !== "approved") throw new Error("Strategy is not approved");
    const transcript = await this.store.readTranscript(projectId, project.activeTranscriptId);
    const source = project.assets.find((asset) => asset.kind === "source_video");
    if (!source) throw new Error("No source video asset");
    const plan = suppliedPlan ?? await this.plannerCall(projectId, () => this.providers.planner.createEditPlan({ projectId, strategy, transcript, assetId: source.id, basedOnVersion: project.activeVersion }, context));
    await this.store.writeEditPlan(projectId, plan);
    await this.store.writeProject({ ...project, activeEditPlanId: plan.id });
    await this.workflow.move(projectId, "VALIDATING", { editPlanId: plan.id });
    return plan;
  }

  async validatePlan(projectId: string, planId: string) {
    const [project, plan] = await Promise.all([this.store.readProject(projectId), this.store.readEditPlan(projectId, planId)]);
    return validateEditPlan(plan, project, project.assets);
  }

  async diffPlan(projectId: string, planId: string) {
    const [project, plan, timeline] = await Promise.all([this.store.readProject(projectId), this.store.readEditPlan(projectId, planId), this.store.readTimeline(projectId)]);
    const transcript = project.activeTranscriptId ? await this.store.readTranscript(projectId, project.activeTranscriptId) : undefined;
    const next = timelineFromPlan(plan, timeline, transcript);
    return diffTimelines(timeline, next, project.activeVersion, project.activeVersion + 1, plan.reason);
  }

  async applyPlan(projectId: string, planId: string) {
    return this.workflow.runStep(projectId, "APPLYING", { planId }, async () => this.store.withLock(projectId, async () => {
      const [project, plan, current] = await Promise.all([this.store.readProject(projectId), this.store.readEditPlan(projectId, planId), this.store.readTimeline(projectId)]);
      const pendingVersion = await this.store.tryReadVersion(projectId, project.activeVersion + 1);
      if (pendingVersion?.operation.type === "apply_plan" && pendingVersion.operation.editPlanId === plan.id) {
        await this.store.writeTimeline(projectId, pendingVersion.timeline);
        await this.store.writeProject({ ...project, activeVersion: pendingVersion.version, activeEditPlanId: plan.id });
        return pendingVersion;
      }
      const validation = validateEditPlan(plan, project, project.assets);
      if (!validation.valid) throw new Error(`EditPlan validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`);
      const transcript = project.activeTranscriptId ? await this.store.readTranscript(projectId, project.activeTranscriptId) : undefined;
      const next = timelineFromPlan(plan, current, transcript);
      const nextVersion = project.activeVersion + 1;
      const version: ProjectVersion = {
        version: nextVersion,
        parentVersion: project.activeVersion,
        timeline: next,
        operation: createOperation("apply_plan", plan.reason, plan.id, plan.feedbackIds),
        diff: diffTimelines(current, next, project.activeVersion, nextVersion, plan.reason),
        createdAt: this.now(),
      };
      await this.store.writeVersion(projectId, version);
      await this.store.writeTimeline(projectId, next);
      await this.store.writeProject({ ...project, activeVersion: nextVersion, activeEditPlanId: plan.id });
      return version;
    }));
  }

  async renderPreview(projectId: string, range?: { startUs: number; endUs: number }, context?: OperationContext) {
    if (range && this.limits.maxPreviewDurationUs && range.endUs - range.startUs > this.limits.maxPreviewDurationUs) throw new Error("Preview range exceeds configured quota");
    const result = await this.workflow.runStep(projectId, "RENDERING_PREVIEW", { range }, async () => {
      const [project, timeline] = await Promise.all([this.store.readProject(projectId), this.store.readTimeline(projectId)]);
      const outputPath = this.store.resolveProjectFile(projectId, `previews/v${project.activeVersion}${range ? `-${range.startUs}-${range.endUs}` : ""}.mp4`);
      const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
      return this.providers.renderer.renderPreview({ projectId, timeline, outputPath, resolveAssetPath: (assetId) => {
        const asset = assetById.get(assetId);
        if (!asset) throw new Error(`Unknown asset ${assetId}`);
        return this.store.resolveProjectFile(projectId, asset.relativePath);
      }, ...(range ? { range } : {}), ...(context?.signal ? { signal: context.signal } : {}), ...(context?.onProgress ? { onProgress: context.onProgress } : {}) });
    });
    const check = this.providers.renderer.id === "fake-renderer"
      ? { passed: true, warnings: result.warnings }
      : this.providers.previewSelfCheck ? await this.providers.previewSelfCheck(result.outputPath, await this.store.readTimeline(projectId), result.durationUs) : { passed: result.warnings.length === 0, warnings: result.warnings };
    if (this.limits.maxRetainedPreviews) await this.store.prunePreviews(projectId, this.limits.maxRetainedPreviews);
    await this.workflow.move(projectId, "WAITING_REVIEW", { preview: result.outputPath, selfCheck: check });
    this.logger.info("preview rendered", { projectId, operation: "preview_render", provider: this.providers.renderer.id, status: check.passed ? "succeeded" : "warning", durationMs: Math.round(result.durationUs / 1000) });
    return { ...result, selfCheck: check };
  }

  async submitFeedback(projectId: string, rawMessage: string, options: { category?: Feedback["category"]; range?: Feedback["range"]; severity?: Feedback["severity"] } = {}) {
    return this.workflow.runStep(projectId, "PROCESSING_FEEDBACK", { rawMessage }, async () => {
      const project = await this.store.readProject(projectId);
      const feedback = normalizeFeedback(project, rawMessage, options.category, options.range, options.severity);
      await this.store.writeFeedback(projectId, feedback);
      return feedback;
    });
  }

  async diagnose(projectId: string) {
    return this.workflow.runStep(projectId, "DIAGNOSING", {}, async () => {
      const project = await this.store.readProject(projectId);
      const feedback = await this.store.listFeedback(projectId);
      const strategy = project.activeStrategyId ? await this.store.readStrategy(projectId, project.activeStrategyId) : undefined;
      const diagnosis = diagnoseFeedback(projectId, feedback, strategy?.structure);
      await this.store.writeDiagnosis(projectId, diagnosis);
      return diagnosis;
    });
  }

  async createPatch(projectId: string, suppliedPatch?: EditPatch, context?: OperationContext) {
    return this.workflow.runStep(projectId, "PATCHING", {}, async () => {
      const project = await this.store.readProject(projectId);
      if (!project.activeEditPlanId || !project.activeTranscriptId) throw new Error("Active EditPlan and Transcript are required for patch planning");
      const [plan, timeline, transcript, feedback] = await Promise.all([
        this.store.readEditPlan(projectId, project.activeEditPlanId),
        this.store.readTimeline(projectId),
        this.store.readTranscript(projectId, project.activeTranscriptId),
        this.store.listFeedback(projectId),
      ]);
      if (feedback.length === 0) throw new Error("Patch planning requires feedback");
      if (!this.providers.planner.createEditPatch && !suppliedPatch) throw new Error("Planner does not support PatchPlan");
      const recent = feedback.slice(-4).map((item) => ({ id: item.id, message: item.message, ...(item.range ? { range: item.range } : {}) }));
      const patch = suppliedPatch ?? await this.plannerCall(projectId, () => this.providers.planner.createEditPatch!({ projectId, plan, timeline, transcript, feedback: recent, basedOnVersion: project.activeVersion }, context));
      await this.store.writeEditPatch(projectId, patch);
      return patch;
    });
  }

  async validatePatch(projectId: string, patchId: string) {
    const [project, patch, timeline] = await Promise.all([this.store.readProject(projectId), this.store.readEditPatch(projectId, patchId), this.store.readTimeline(projectId)]);
    if (!project.activeEditPlanId) throw new Error("No active EditPlan");
    const plan = await this.store.readEditPlan(projectId, project.activeEditPlanId);
    return validateEditPatch(patch, project, plan, timeline, project.assets);
  }

  async diffPatch(projectId: string, patchId: string) {
    const [project, patch, current] = await Promise.all([this.store.readProject(projectId), this.store.readEditPatch(projectId, patchId), this.store.readTimeline(projectId)]);
    if (!project.activeEditPlanId) throw new Error("No active EditPlan");
    const [plan, transcript] = await Promise.all([this.store.readEditPlan(projectId, project.activeEditPlanId), project.activeTranscriptId ? this.store.readTranscript(projectId, project.activeTranscriptId) : Promise.resolve(undefined)]);
    const next = timelineFromPatch(plan, patch, current, transcript).timeline;
    return diffTimelines(current, next, project.activeVersion, project.activeVersion + 1, patch.reason);
  }

  async applyPatch(projectId: string, patchId: string) {
    await this.workflow.move(projectId, "VALIDATING", { patchId });
    return this.workflow.runStep(projectId, "APPLYING", { patchId }, async () => this.store.withLock(projectId, async () => {
      const [project, patch, current] = await Promise.all([this.store.readProject(projectId), this.store.readEditPatch(projectId, patchId), this.store.readTimeline(projectId)]);
      const pendingVersion = await this.store.tryReadVersion(projectId, project.activeVersion + 1);
      if (pendingVersion?.operation.type === "patch" && pendingVersion.operation.patchId === patch.id) {
        await this.store.writeTimeline(projectId, pendingVersion.timeline);
        await this.store.writeProject({ ...project, activeVersion: pendingVersion.version, activeEditPlanId: pendingVersion.operation.editPlanId });
        return pendingVersion;
      }
      if (!project.activeEditPlanId) throw new Error("No active EditPlan");
      const [plan, transcript] = await Promise.all([this.store.readEditPlan(projectId, project.activeEditPlanId), project.activeTranscriptId ? this.store.readTranscript(projectId, project.activeTranscriptId) : Promise.resolve(undefined)]);
      const validation = validateEditPatch(patch, project, plan, current, project.assets);
      if (!validation.valid) throw new Error(`EditPatch validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`);
      const applied = timelineFromPatch(plan, patch, current, transcript);
      const nextVersion = project.activeVersion + 1;
      const version: ProjectVersion = { version: nextVersion, parentVersion: project.activeVersion, timeline: applied.timeline, operation: createOperation("patch", patch.reason, applied.plan.id, patch.feedbackIds, patch.id), diff: diffTimelines(current, applied.timeline, project.activeVersion, nextVersion, patch.reason), createdAt: this.now() };
      await this.store.writeEditPlan(projectId, applied.plan);
      await this.store.writeVersion(projectId, version);
      await this.store.writeTimeline(projectId, applied.timeline);
      await this.store.writeProject({ ...project, activeVersion: nextVersion, activeEditPlanId: applied.plan.id, finalApprovedVersion: undefined });
      this.logger.info("patch applied", { projectId, operation: "edit_patch_apply", status: "succeeded", patchId, version: nextVersion });
      return version;
    }));
  }

  async replan(projectId: string) {
    const replanned = await this.workflow.runStep(projectId, "REPLANNING", {}, async () => {
      const project = await this.store.readProject(projectId);
      if (!project.activeStrategyId) throw new Error("No active strategy to revise");
      const [current, transcript, feedback] = await Promise.all([
        this.store.readStrategy(projectId, project.activeStrategyId),
        this.readTranscript(projectId),
        this.store.listFeedback(projectId),
      ]);
      const diagnosis = diagnoseFeedback(projectId, feedback, current.structure);
      if (diagnosis.recommendedAction !== "REPLAN") throw new Error(`Diagnosis recommends ${diagnosis.recommendedAction}, not REPLAN`);
      const prompt = `Revise the current strategy after repeated review feedback. Evidence: ${diagnosis.evidence.join(" | ")}`;
      const proposed = await this.plannerCall(projectId, () => this.providers.planner.proposeStrategy({ projectId, prompt, transcript, targetDurationUs: current.targetDurationUs }));
      const next: EditingStrategy = {
        ...proposed,
        structure: diagnosis.strategyChanges.some((change) => change.field === "structure") ? "hook-first" : proposed.structure,
        pace: diagnosis.strategyChanges.some((change) => change.field === "pace") ? "fast" : proposed.pace,
        rationale: [...proposed.rationale, ...diagnosis.strategyChanges.map((change) => change.reason)],
        status: "proposed",
      };
      await this.store.writeStrategy(projectId, { ...current, status: "superseded" });
      await this.store.writeStrategy(projectId, next);
      await this.store.writeProject({ ...project, activeStrategyId: next.id, activeEditPlanId: undefined });
      return { diagnosis, strategy: next };
    });
    await this.workflow.move(projectId, "WAITING_PROPOSAL_APPROVAL", { strategyId: replanned.strategy.id });
    return replanned;
  }

  async addNarration(projectId: string, input: { text: string; voiceId: string; language: string; timelineInUs: number; targetDurationUs?: number; actionOnOverflow?: "extend" | "fail" }, context?: OperationContext) {
    return this.store.withLock(projectId, async () => {
      const project = await this.store.readProject(projectId);
      const speech = await synthesizeSpeech(this.primitives, this.store, projectId, this.providers.tts, input, context);
      const fit = input.targetDurationUs ? fitTtsToRange(speech.durationUs / 1_000_000, input.targetDurationUs / 1_000_000) : undefined;
      if (fit && !fit.fits && input.actionOnOverflow !== "extend") throw new Error("TTS does not fit target range; rewrite or explicit timeline extension is required");
      const timeline = await this.store.readTimeline(projectId);
      const assetPath = `derived/${speech.id}.wav`;
      const audioSizeBytes = await this.store.projectFileSize(projectId, assetPath);
      const asset = {
        id: speech.assetId,
        kind: "tts" as const,
        originalName: `${speech.id}.wav`,
        relativePath: assetPath,
        sha256: await this.primitives.crypto.sha256(JSON.stringify(speech)),
        metadata: { durationUs: speech.durationUs, audioCodec: "pcm_s16le", sampleRate: speech.sampleRate, channels: 1, sizeBytes: audioSizeBytes },
        createdAt: speech.createdAt,
        provenance: { provider: speech.provider, model: speech.model, sourceAssetIds: [] },
      };
      const narrationTrack = timeline.tracks.find((track) => track.type === "narration") ?? { id: "narration", type: "narration" as const, name: "Narration", muted: false, gainDb: 0, clips: [] };
      const narrationClip = { id: `narration-${this.id()}`, type: "audio" as const, assetId: speech.assetId, sourceInUs: 0, sourceOutUs: speech.durationUs, timelineInUs: input.timelineInUs, timelineOutUs: input.timelineInUs + speech.durationUs, speed: 1, gainDb: 0, transcriptWordIds: speech.wordTimings.map((word) => word.id), metadata: { speechAssetId: speech.id } };
      const captionTrack = timeline.tracks.find((track) => track.type === "caption") ?? { id: "captions", type: "caption" as const, name: "Captions", muted: false, gainDb: 0, clips: [] };
      const newCaptions = speech.wordTimings.map((word) => ({ id: `caption-${this.id()}`, type: "caption" as const, sourceInUs: word.startUs, sourceOutUs: word.endUs, timelineInUs: input.timelineInUs + word.startUs, timelineOutUs: input.timelineInUs + word.endUs, speed: 1, text: word.displayText, transcriptWordIds: [word.id], metadata: { source: "tts", style: "minimal" } }));
      const captionsOutsideNarration = captionTrack.clips.filter((clip) => clip.timelineOutUs <= narrationClip.timelineInUs || clip.timelineInUs >= narrationClip.timelineOutUs);
      const tracks = timeline.tracks.filter((track) => track.id !== narrationTrack.id && track.id !== captionTrack.id).map((track) => track.type === "original_audio" ? { ...track, ducking: { enabled: true, targetGainDb: -12 } } : track);
      tracks.push({ ...narrationTrack, clips: [...narrationTrack.clips, narrationClip] }, { ...captionTrack, clips: [...captionsOutsideNarration, ...newCaptions] });
      const next = { ...timeline, tracks, durationUs: Math.max(timeline.durationUs, narrationClip.timelineOutUs), updatedAt: this.now() };
      const nextVersion = project.activeVersion + 1;
      const reason = `Add narration: ${input.text}`;
      const version: ProjectVersion = { version: nextVersion, parentVersion: project.activeVersion, timeline: next, operation: createOperation("add_narration", reason), diff: diffTimelines(timeline, next, project.activeVersion, nextVersion, reason), createdAt: this.now() };
      await this.store.writeVersion(projectId, version);
      await this.store.writeTimeline(projectId, next);
      await this.store.writeProject({ ...project, assets: project.assets.some((item) => item.id === asset.id) ? project.assets : [...project.assets, asset], activeVersion: nextVersion });
      return { speech, fit, version };
    });
  }

  async approveFinal(projectId: string) {
    const project = await this.store.readProject(projectId);
    if (project.activeVersion < 1) throw new Error("No applied version to approve");
    await this.store.writeProject({ ...project, finalApprovedVersion: project.activeVersion });
    await this.workflow.move(projectId, "WAITING_FINAL_APPROVAL", { version: project.activeVersion });
    return { approvedVersion: project.activeVersion };
  }

  async exportVideo(projectId: string, context?: OperationContext) {
    const result = await this.workflow.runStep(projectId, "EXPORTING", {}, async () => {
      const [project, timeline] = await Promise.all([this.store.readProject(projectId), this.store.readTimeline(projectId)]);
      if (project.finalApprovedVersion !== project.activeVersion) throw new Error("Active version does not have explicit final approval");
      const outputPath = this.store.resolveProjectFile(projectId, `exports/v${project.activeVersion}-final.mp4`);
      const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
      return this.providers.renderer.renderFinal({ projectId, timeline, outputPath, resolveAssetPath: (assetId) => {
        const asset = assetById.get(assetId);
        if (!asset) throw new Error(`Unknown asset ${assetId}`);
        return this.store.resolveProjectFile(projectId, asset.relativePath);
      }, ...(context?.signal ? { signal: context.signal } : {}), ...(context?.onProgress ? { onProgress: context.onProgress } : {}) });
    });
    const manifest = await this.exportProvenanceManifest(projectId);
    await this.workflow.move(projectId, "DONE", { outputPath: result.outputPath, manifestPath: manifest.path });
    return { ...result, manifestPath: manifest.path };
  }

  async exportProvenanceManifest(projectId: string) { const [project, timeline, speechAssets] = await Promise.all([this.store.readProject(projectId), this.store.readTimeline(projectId), this.store.listSpeechAssets(projectId)]); const speechById = new Map(speechAssets.map((item) => [item.id, item])); const manifest = { schemaVersion: 1, projectId, version: project.activeVersion, createdAt: this.now(), audio: timeline.tracks.filter((track) => ["original_audio", "narration", "tts_replacement", "dubbing"].includes(track.type)).flatMap((track) => track.clips.map((clip) => { const speech = typeof clip.metadata.speechAssetId === "string" ? speechById.get(clip.metadata.speechAssetId) : undefined; return { trackId: track.id, clipId: clip.id, kind: track.type === "original_audio" ? "original_audio" : speech?.type ?? "standard_tts", assetId: clip.assetId, speechAssetId: speech?.id, voiceProfileId: speech?.voiceProfileId, provider: speech?.provider, model: speech?.model, sourceText: speech?.sourceText, sourceTextVersion: speech?.sourceTextVersion, sourceSegmentIds: speech?.sourceSegmentIds ?? [], generated: speech?.generated ?? false }; })) }; const relativePath = `exports/v${project.activeVersion}-provenance.json`; await this.store.writeProjectFile(projectId, relativePath, `${JSON.stringify(manifest, null, 2)}\n`); return { path: this.store.resolveProjectFile(projectId, relativePath), manifest }; }

  async listVersions(projectId: string) {
    return this.store.listVersions(projectId);
  }

  async compareVersions(projectId: string, from: number, to: number) {
    const [a, b] = await Promise.all([this.store.readVersion(projectId, from), this.store.readVersion(projectId, to)]);
    return diffTimelines(a.timeline, b.timeline, from, to, `Compare v${from} to v${to}`);
  }

  async restoreVersion(projectId: string, versionNumber: number) {
    return this.store.withLock(projectId, async () => {
      const [project, current, target] = await Promise.all([this.store.readProject(projectId), this.store.readTimeline(projectId), this.store.readVersion(projectId, versionNumber)]);
      const pendingVersion = await this.store.tryReadVersion(projectId, project.activeVersion + 1);
      if (pendingVersion?.operation.type === "restore_version" && pendingVersion.operation.restoredVersion === versionNumber) {
        await this.store.writeTimeline(projectId, pendingVersion.timeline);
        await this.store.writeProject({ ...project, activeVersion: pendingVersion.version });
        return pendingVersion;
      }
      const nextVersion = project.activeVersion + 1;
      const timeline = { ...target.timeline, id: this.id(), updatedAt: this.now() };
      const reason = `Restore v${versionNumber}`;
      const version: ProjectVersion = { version: nextVersion, parentVersion: project.activeVersion, timeline, operation: createOperation("restore_version", reason, undefined, [], undefined, versionNumber), diff: diffTimelines(current, timeline, project.activeVersion, nextVersion, reason), createdAt: this.now() };
      await this.store.writeVersion(projectId, version);
      await this.store.writeTimeline(projectId, timeline);
      await this.store.writeProject({ ...project, activeVersion: nextVersion });
      return version;
    });
  }
}
