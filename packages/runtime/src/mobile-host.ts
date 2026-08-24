import { editPlanSchema, editingStrategySchema, projectSchema, timelineSchema, transcriptSchema, type Asset, type EditPlan, type EditingStrategy, type Job, type JobEvent, type Project, type ProjectVersion, type Timeline, type Transcript } from "../../core/src/index.js";
import { diffTimelines, timelineFromPlan, validateEditPlan } from "../../core/src/index.js";
import { DurableJobQueue, type JobStore } from "../../jobs/src/index.js";
import { MemoryBackgroundExecution, MemorySecureStorage, SystemClock, WebCryptoAdapter, WebIdAdapter, type HostProfile, type LogicalUri } from "../../platform/src/index.js";

class MemoryFileSystem {
  readonly files = new Map<LogicalUri, Uint8Array>();
  async read(uri: LogicalUri) { const value = this.files.get(uri); if (!value) throw new Error(`Missing ${uri}`); return value.slice(); }
  async write(uri: LogicalUri, data: Uint8Array, options?: { createOnly?: boolean }) { if (options?.createOnly && this.files.has(uri)) throw new Error(`Already exists: ${uri}`); this.files.set(uri, data.slice()); }
  async delete(uri: LogicalUri) { this.files.delete(uri); }
  async exists(uri: LogicalUri) { return this.files.has(uri); }
  async stat(uri: LogicalUri) { const value = await this.read(uri); return { sizeBytes: value.byteLength, kind: "file" as const }; }
  async list(uri: LogicalUri) { return [...this.files.keys()].filter((item) => item.startsWith(uri)); }
  async copy(source: LogicalUri, destination: LogicalUri) { await this.write(destination, await this.read(source)); }
}

class RejectingHttpAdapter {
  async request(): Promise<never> { throw new Error("Mobile simulation has no network route; inject a provider test adapter explicitly"); }
}

class MobileJobStore implements JobStore {
  readonly jobs = new Map<string, Job>(); readonly events: JobEvent[] = [];
  constructor(private readonly projectIds: () => string[]) {}
  async listProjectIds() { return this.projectIds(); }
  async sweepTemporaryFiles() { return []; }
  async listJobs(projectId: string) { return [...this.jobs.values()].filter((job) => job.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async readJob(projectId: string, jobId: string) { const job = this.jobs.get(jobId); if (!job || job.projectId !== projectId) throw new Error(`Job ${jobId} not found`); return job; }
  async writeJob(_projectId: string, job: Job) { this.jobs.set(job.id, job); }
  async writeJobEvent(_projectId: string, event: JobEvent) { this.events.push(event); }
}

export interface MobileHostResult { project: Project; transcript: Transcript; strategy: EditingStrategy; plan: EditPlan; timeline: Timeline; version: ProjectVersion; previewUri: LogicalUri; providerMode: "remote-text-fake"; backendRequests: 0 }

export class MobileHostRuntime {
  readonly profile: HostProfile;
  readonly projects = new Map<string, Project>();
  readonly transcripts = new Map<string, Transcript>();
  readonly versions = new Map<string, ProjectVersion[]>();
  readonly jobStore = new MobileJobStore(() => [...this.projects.keys()]);
  readonly queue: DurableJobQueue;

  constructor() {
    const clock = new SystemClock(); const ids = new WebIdAdapter(); const crypto = new WebCryptoAdapter(); const background = new MemoryBackgroundExecution(25_000);
    this.profile = { id: "mobile-simulation", primitives: { clock, ids, crypto }, filesystem: new MemoryFileSystem(), secureStorage: new MemorySecureStorage(), http: new RejectingHttpAdapter(), background, capabilities: { host: "mobile-simulation", media: { probe: true, previewRender: true, finalRender: true, frameExtraction: false, waveform: false, backgroundExport: false, hardwareDecode: false, hardwareEncode: false, maxWidth: 1920, maxHeight: 1080 }, localAsr: true, localTts: true, alignment: false, diarization: false, voiceClone: false, backgroundExecution: true, resourceBudget: { maxWorkingSetBytes: 512 * 1024 * 1024, maxConcurrentMediaJobs: 1, previewMaxWidth: 960, previewMaxDurationUs: 120_000_000, thermalState: "unknown", powerState: "unknown" } } };
    this.queue = new DurableJobQueue(this.jobStore, { concurrency: 1, maxAttempts: 2, baseRetryMs: 1 }, clock, ids, background);
  }

  private now() { return this.profile.primitives.clock.now().toISOString(); }
  async createProject(name: string): Promise<Project> {
    const id = `mobile-${this.profile.primitives.ids.create().slice(0, 8).toLowerCase()}`; const now = this.now();
    const project = projectSchema.parse({ schemaVersion: 1, id, name, createdAt: now, updatedAt: now, assets: [], activeVersion: 0, workflowRunId: this.profile.primitives.ids.create() });
    this.projects.set(id, project); return project;
  }
  async importVideo(projectId: string, bytes: Uint8Array, name = "mobile-import.mp4", durationUs = 12_000_000): Promise<Asset> {
    const project = this.projects.get(projectId); if (!project) throw new Error(`Project ${projectId} not found`);
    const assetId = this.profile.primitives.ids.create(); const uri = `project://${projectId}/assets/${assetId}.mp4` as LogicalUri; await this.profile.filesystem.write(uri, bytes, { atomic: true, createOnly: true });
    const asset: Asset = { id: assetId, kind: "source_video", originalName: name, relativePath: `assets/${assetId}.mp4`, ref: { uri, storageClass: "durable", mediaType: "video/mp4", displayName: name }, sha256: await this.profile.primitives.crypto.sha256(bytes), metadata: { durationUs, sizeBytes: bytes.byteLength, width: 720, height: 1280, frameRate: { numerator: 30, denominator: 1 } }, createdAt: this.now() };
    this.projects.set(projectId, { ...project, assets: [...project.assets, asset], updatedAt: this.now() }); return asset;
  }
  async transcribeLocal(projectId: string, assetId: string): Promise<Transcript> {
    const project = this.projects.get(projectId); const asset = project?.assets.find((item) => item.id === assetId); if (!project || !asset) throw new Error("Unknown project asset");
    const text = "Local analysis keeps raw video private while a compact transcript guides the edit"; const tokens = text.split(" ");
    const words = tokens.map((token, index) => ({ id: this.profile.primitives.ids.create(), rawText: token, normalizedText: token.toLowerCase(), displayText: token, startUs: index * 500_000, endUs: index * 500_000 + 420_000, confidence: 0.98, speakerId: "speaker-1", timingSource: "asr" as const }));
    const transcript = transcriptSchema.parse({ schemaVersion: 1, id: this.profile.primitives.ids.create(), assetId, provider: "mobile-local-asr-fake", model: "deterministic-v1", language: "en", languageConfidence: 1, rawTranscript: text, normalizedTranscript: text.toLowerCase(), displayTranscript: text, words, segments: [{ id: this.profile.primitives.ids.create(), startUs: 0, endUs: words.at(-1)!.endUs, speakerId: "speaker-1", language: "en", confidence: 0.98, rawText: text, normalizedText: text.toLowerCase(), displayText: text, wordIds: words.map((word) => word.id) }], speakers: [{ id: "speaker-1", label: "Speaker 1" }], silenceRegions: [], quality: { warnings: ["Deterministic mobile-host fixture"] }, cacheKey: await this.profile.primitives.crypto.sha256(`${asset.sha256}:mobile-asr-v1`), createdAt: this.now() });
    this.transcripts.set(transcript.id, transcript); this.projects.set(projectId, { ...project, activeTranscriptId: transcript.id, updatedAt: this.now() }); return transcript;
  }
  async planRemoteTextOnly(projectId: string, assetId: string, transcript: Transcript): Promise<{ strategy: EditingStrategy; plan: EditPlan }> {
    const project = this.projects.get(projectId); if (!project) throw new Error("Unknown project");
    const strategy = editingStrategySchema.parse({ schemaVersion: 1, id: this.profile.primitives.ids.create(), goal: "Create a concise privacy-preserving mobile edit", structure: "hook-first", targetDurationUs: 8_000_000, pace: "fast", tone: "natural", selectionPolicy: "transcript evidence only", preserveOriginalMeaning: true, preserveOriginalWording: true, captionStyle: "minimal", brollPolicy: "none", rationale: ["Remote fake receives text only"], status: "approved", createdAt: this.now() });
    const source = transcript.segments[0]!; const plan = editPlanSchema.parse({ schemaVersion: 1, id: this.profile.primitives.ids.create(), projectId, goal: strategy.goal, strategyId: strategy.id, segments: [{ id: this.profile.primitives.ids.create(), assetId, sourceInUs: source.startUs, sourceOutUs: source.endUs, timelineInUs: 0, speed: 1, reason: "Evidence-backed compact hook", transcriptSegmentIds: [source.id] }], captions: { enabled: true, style: "minimal" }, audio: { normalize: true, originalAudio: "keep", originalGainDb: 0, ducking: { enabled: false, targetGainDb: -12 } }, reason: "Remote text-only fake plan", basedOnVersion: project.activeVersion, feedbackIds: [], createdAt: this.now() });
    if (!validateEditPlan(plan, project, project.assets).valid) throw new Error("Mobile plan failed validation"); return { strategy, plan };
  }
  async applyAndRender(projectId: string, plan: EditPlan, transcript: Transcript): Promise<{ timeline: Timeline; version: ProjectVersion; previewUri: LogicalUri }> {
    const project = this.projects.get(projectId); if (!project) throw new Error("Unknown project");
    const empty = timelineSchema.parse({ schemaVersion: 1, id: this.profile.primitives.ids.create(), projectId, frameRate: { numerator: 30, denominator: 1 }, width: 720, height: 1280, durationUs: 0, tracks: [], updatedAt: this.now() });
    const timeline = timelineFromPlan(plan, empty, transcript); const versionNumber = project.activeVersion + 1;
    const version: ProjectVersion = { version: versionNumber, parentVersion: project.activeVersion, timeline, operation: { id: this.profile.primitives.ids.create(), type: "apply_plan", reason: plan.reason, editPlanId: plan.id, feedbackIds: [], createdAt: this.now() }, diff: diffTimelines(empty, timeline, project.activeVersion, versionNumber, plan.reason), createdAt: this.now() };
    this.versions.set(projectId, [...(this.versions.get(projectId) ?? []), version]); this.projects.set(projectId, { ...project, activeVersion: versionNumber, activeEditPlanId: plan.id, activeStrategyId: plan.strategyId, updatedAt: this.now() });
    const previewUri = `project://${projectId}/previews/v${versionNumber}.json` as LogicalUri; await this.profile.filesystem.write(previewUri, new TextEncoder().encode(JSON.stringify({ timeline, renderer: "mobile-local-renderer-fake" })), { atomic: true }); return { timeline, version, previewUri };
  }
  async runZeroServerDemo(): Promise<MobileHostResult> {
    const project = await this.createProject("Mobile zero-server demo"); const asset = await this.importVideo(project.id, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])); const transcript = await this.transcribeLocal(project.id, asset.id); const { strategy, plan } = await this.planRemoteTextOnly(project.id, asset.id, transcript); const rendered = await this.applyAndRender(project.id, plan, transcript);
    return { project: this.projects.get(project.id)!, transcript, strategy, plan, ...rendered, providerMode: "remote-text-fake", backendRequests: 0 };
  }
}

/** UI-safe surface: commands and queries only; no workflow or timeline rules belong in UI components. */
export class MobileVideoAgentFacade {
  constructor(private readonly runtime: MobileHostRuntime) {}
  createProject(name: string) { return this.runtime.createProject(name); }
  importVideo(projectId: string, bytes: Uint8Array, name?: string, durationUs?: number) { return this.runtime.importVideo(projectId, bytes, name, durationUs); }
  transcribe(projectId: string, assetId: string) { return this.runtime.transcribeLocal(projectId, assetId); }
  async planAndApply(projectId: string, assetId: string, transcript: Transcript) { const { strategy, plan } = await this.runtime.planRemoteTextOnly(projectId, assetId, transcript); return { strategy, plan, ...await this.runtime.applyAndRender(projectId, plan, transcript) }; }
  project(projectId: string) { return this.runtime.projects.get(projectId); }
  versions(projectId: string) { return [...(this.runtime.versions.get(projectId) ?? [])]; }
  capabilities() { return this.runtime.profile.capabilities; }
}
