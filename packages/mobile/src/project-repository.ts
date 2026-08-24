import {
  diagnosisSchema, editPatchSchema, editPlanSchema, editingStrategySchema, feedbackSchema, jobEventSchema, jobSchema, projectSchema, projectVersionSchema, providerCallSchema, speechAssetSchema, timelineSchema, transcriptSchema, visualEvidenceSchema, voiceDeletionEventSchema, voiceProfileSchema, voiceReferenceQualityReportSchema, workflowRunSchema,
  type Diagnosis, type EditPatch, type EditPlan, type EditingStrategy, type Feedback, type Job, type JobEvent, type Project, type ProjectVersion, type ProviderCall, type SpeechAsset, type Timeline, type Transcript, type VisualEvidence, type VoiceDeletionEvent, type VoiceProfile, type VoiceReferenceQualityReport, type WorkflowRun,
} from "../../core/src/schemas.js";
import type { ProjectRepository } from "../../core/src/repository.js";
import type { ClockAdapter, CryptoAdapter, FileSystemAdapter, IdAdapter, LogicalUri } from "../../platform/src/contracts.js";
import type { NativeVideoHostBridge } from "./native-bridge.js";

type Schema<T> = { parse(value: unknown): T };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{2,100}$/;
const MOBILE_IO_CONCURRENCY = 6;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class MobileProjectRepository implements ProjectRepository {
  private readonly locked = new Set<string>();
  constructor(private readonly filesystem: FileSystemAdapter, private readonly native: NativeVideoHostBridge, private readonly clock: ClockAdapter, private readonly ids: IdAdapter, private readonly crypto: CryptoAdapter) {}
  private now() { return this.clock.now().toISOString(); }
  private uri(projectId: string, relativePath = ""): LogicalUri { if (!PROJECT_ID.test(projectId)) throw new Error(`Invalid project id: ${projectId}`); const clean = relativePath.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, ""); if (clean.split("/").includes("..")) throw new Error("Project path traversal rejected"); return `project://${projectId}/${clean}` as LogicalUri; }
  private async writeJson<T>(projectId: string, relativePath: string, value: T, schema: Schema<T>) { await this.filesystem.write(this.uri(projectId, relativePath), encoder.encode(`${JSON.stringify(schema.parse(value))}\n`), { atomic: true }); }
  private async readJson<T>(projectId: string, relativePath: string, schema: Schema<T>) { return schema.parse(JSON.parse(decoder.decode(await this.filesystem.read(this.uri(projectId, relativePath))))); }
  private async jsonUris(projectId: string, directory: string, include: (name: string) => boolean = () => true) { const prefix = this.uri(projectId, directory); let uris: LogicalUri[]; try { uris = await this.filesystem.list(prefix); } catch { return []; } return uris.filter((uri) => uri.endsWith(".json") && include(uri.slice(uri.lastIndexOf("/") + 1))); }
  private async readJsonUri<T>(uri: LogicalUri, schema: Schema<T>) { return schema.parse(JSON.parse(decoder.decode(await this.filesystem.read(uri)))); }
  private async jsonItems<T>(projectId: string, directory: string, schema: Schema<T>, include: (name: string) => boolean = () => true) { const uris = await this.jsonUris(projectId, directory, include); return mapLimit(uris, MOBILE_IO_CONCURRENCY, (uri) => this.readJsonUri(uri, schema)); }
  private async findJsonItem<T>(projectId: string, directory: string, schema: Schema<T>, predicate: (value: T) => boolean) { for (const uri of await this.jsonUris(projectId, directory)) { const value = await this.readJsonUri(uri, schema); if (predicate(value)) return value; } return undefined; }

  async create(name: string) {
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "video";
    const projectId = `${slug}-${this.ids.create().replace(/[^a-z0-9]/giu, "").slice(0, 8).toLowerCase()}`; const now = this.now();
    const timeline = timelineSchema.parse({ schemaVersion: 1, id: this.ids.create(), projectId, frameRate: { numerator: 30, denominator: 1 }, width: 1080, height: 1920, durationUs: 0, tracks: [], updatedAt: now });
    const workflow = workflowRunSchema.parse({ schemaVersion: 1, id: this.ids.create(), projectId, state: "CREATED", steps: [], updatedAt: now });
    const project = projectSchema.parse({ schemaVersion: 1, id: projectId, name, createdAt: now, updatedAt: now, assets: [], activeVersion: 0, workflowRunId: workflow.id });
    await this.writeJson(projectId, "project.json", project, projectSchema); await this.writeJson(projectId, "edits/timeline.json", timeline, timelineSchema); await this.writeJson(projectId, "workflow/run.json", workflow, workflowRunSchema);
    return { project, timeline, workflow, root: this.uri(projectId) };
  }
  async listProjectIds() { const roots = await this.filesystem.list("project://" as LogicalUri); return [...new Set(roots.map((uri) => uri.slice("project://".length).split("/")[0]).filter((id): id is string => Boolean(id && PROJECT_ID.test(id))))].sort(); }
  async projectDiskUsage(projectId: string) { const files = await this.filesystem.list(this.uri(projectId)); const stats = await mapLimit(files, MOBILE_IO_CONCURRENCY, (uri) => this.filesystem.stat(uri).catch(() => undefined)); return stats.reduce((sum, item) => sum + (item?.kind === "file" ? item.sizeBytes : 0), 0); }
  async prunePreviews(projectId: string, retain: number) { const files = (await this.filesystem.list(this.uri(projectId, "previews"))).filter((uri) => uri.endsWith(".mp4")); const entries = await mapLimit(files, MOBILE_IO_CONCURRENCY, async (uri) => ({ uri, stat: await this.filesystem.stat(uri) })); const removed = entries.sort((a, b) => (b.stat.modifiedAt ?? "").localeCompare(a.stat.modifiedAt ?? "")).slice(Math.max(0, retain)); await mapLimit(removed, MOBILE_IO_CONCURRENCY, async ({ uri }) => { await this.filesystem.delete(uri); }); return removed.map(({ uri }) => uri.slice(uri.lastIndexOf("/") + 1)); }
  async sweepTemporaryFiles(projectId: string) { const files = await this.filesystem.list(this.uri(projectId)); const temporary = files.filter((uri) => /(?:\.tmp|\.captions\.srt)$/u.test(uri) || uri.includes(".tmp.mp4")); await mapLimit(temporary, MOBILE_IO_CONCURRENCY, async (uri) => { await this.filesystem.delete(uri).catch(() => undefined); }); return temporary; }

  readProject(id: string) { return this.readJson(id, "project.json", projectSchema); }
  async writeProject(project: Project) { await this.writeJson(project.id, "project.json", { ...project, updatedAt: this.now() }, projectSchema); }
  readTimeline(id: string) { return this.readJson(id, "edits/timeline.json", timelineSchema); }
  writeTimeline(id: string, value: Timeline) { return this.writeJson(id, "edits/timeline.json", value, timelineSchema); }
  readWorkflow(id: string) { return this.readJson(id, "workflow/run.json", workflowRunSchema); }
  writeWorkflow(id: string, value: WorkflowRun) { return this.writeJson(id, "workflow/run.json", value, workflowRunSchema); }
  writeTranscript(id: string, value: Transcript) { return this.writeJson(id, `transcripts/${value.id}.json`, value, transcriptSchema); }
  readTranscript(id: string, valueId: string) { return this.readJson(id, `transcripts/${valueId}.json`, transcriptSchema); }
  findTranscriptByCacheKey(id: string, key: string) { return this.findJsonItem(id, "transcripts", transcriptSchema, (item) => item.cacheKey === key); }
  writeStrategy(id: string, value: EditingStrategy) { return this.writeJson(id, `edits/strategies/${value.id}.json`, value, editingStrategySchema); }
  readStrategy(id: string, valueId: string) { return this.readJson(id, `edits/strategies/${valueId}.json`, editingStrategySchema); }
  writeEditPlan(id: string, value: EditPlan) { return this.writeJson(id, `edits/plans/${value.id}.json`, value, editPlanSchema); }
  readEditPlan(id: string, valueId: string) { return this.readJson(id, `edits/plans/${valueId}.json`, editPlanSchema); }
  writeEditPatch(id: string, value: EditPatch) { return this.writeJson(id, `edits/patches/${value.id}.json`, value, editPatchSchema); }
  readEditPatch(id: string, valueId: string) { return this.readJson(id, `edits/patches/${valueId}.json`, editPatchSchema); }
  writeVersion(id: string, value: ProjectVersion) { return this.writeJson(id, `edits/versions/v${value.version}.json`, value, projectVersionSchema); }
  readVersion(id: string, version: number) { return this.readJson(id, `edits/versions/v${version}.json`, projectVersionSchema); }
  async tryReadVersion(id: string, version: number) { try { return await this.readVersion(id, version); } catch { return undefined; } }
  async listVersions(id: string) { return (await this.jsonItems(id, "edits/versions", projectVersionSchema)).sort((a, b) => a.version - b.version); }
  writeFeedback(id: string, value: Feedback) { return this.writeJson(id, `feedback/${value.id}.json`, value, feedbackSchema); }
  async listFeedback(id: string) { return (await this.jsonItems(id, "feedback", feedbackSchema, (name) => !name.startsWith("diagnosis-"))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  writeDiagnosis(id: string, value: Diagnosis) { return this.writeJson(id, `feedback/diagnosis-${value.id}.json`, value, diagnosisSchema); }
  writeSpeechAsset(id: string, value: SpeechAsset) { return this.writeJson(id, `speech/${value.id}.json`, value, speechAssetSchema); }
  readSpeechAsset(id: string, valueId: string) { return this.readJson(id, `speech/${valueId}.json`, speechAssetSchema); }
  listSpeechAssets(id: string) { return this.jsonItems(id, "speech", speechAssetSchema); }
  findSpeechAssetByCacheKey(id: string, key: string) { return this.findJsonItem(id, "speech", speechAssetSchema, (item) => item.cacheKey === key); }
  writeVoiceProfile(id: string, value: VoiceProfile) { return this.writeJson(id, `voices/profiles/${value.id}.json`, value, voiceProfileSchema); }
  readVoiceProfile(id: string, valueId: string) { return this.readJson(id, `voices/profiles/${valueId}.json`, voiceProfileSchema); }
  async listVoiceProfiles(id: string, includeDeleted = false) { const values = await this.jsonItems(id, "voices/profiles", voiceProfileSchema); return values.filter((item) => includeDeleted || item.status !== "deleted"); }
  writeVoiceDeletionEvent(id: string, value: VoiceDeletionEvent) { return this.writeJson(id, `voices/deletions/${value.createdAt.replace(/[:.]/gu, "-")}-${value.id}.json`, value, voiceDeletionEventSchema); }
  writeVoiceReferenceQuality(id: string, value: VoiceReferenceQualityReport) { return this.writeJson(id, `analysis/voice/${value.id}.json`, value, voiceReferenceQualityReportSchema); }
  findVoiceReferenceQualityByCacheKey(id: string, key: string) { return this.findJsonItem(id, "analysis/voice", voiceReferenceQualityReportSchema, (item) => item.cacheKey === key); }
  writeJob(id: string, value: Job) { return this.writeJson(id, `jobs/${value.id}.json`, value, jobSchema); }
  readJob(id: string, valueId: string) { return this.readJson(id, `jobs/${valueId}.json`, jobSchema); }
  async listJobs(id: string) { return (await this.jsonItems(id, "jobs", jobSchema)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  writeJobEvent(id: string, value: JobEvent) { return this.writeJson(id, `events/${value.createdAt.replace(/[:.]/gu, "-")}-${value.id}.json`, value, jobEventSchema); }
  writeProviderCall(id: string, value: ProviderCall) { return this.writeJson(id, `provider-calls/${value.id}.json`, value, providerCallSchema); }
  writeVisualEvidence(id: string, value: VisualEvidence) { return this.writeJson(id, `analysis/visual/${value.id}.json`, value, visualEvidenceSchema); }
  listVisualEvidence(id: string) { return this.jsonItems(id, "analysis/visual", visualEvidenceSchema); }

  async copySourceAsset(projectId: string, sourceUri: string, maxBytes: number) { const stat = await this.native.stat(sourceUri as LogicalUri); if (stat.sizeBytes > maxBytes) throw new Error(`Source media exceeds ${maxBytes} byte limit`); const name = sourceUri.slice(sourceUri.lastIndexOf("/") + 1).replace(/[^a-zA-Z0-9._-]+/gu, "-") || "import.mp4"; const relativePath = `assets/${this.ids.create()}-${name}`; const destination = this.uri(projectId, relativePath); await this.native.copy(sourceUri, destination); return { relativePath, sha256: await this.native.sha256File(destination), sizeBytes: stat.sizeBytes }; }
  resolveProjectFile(projectId: string, relativePath: string) { return this.uri(projectId, relativePath); }
  removeProjectFile(projectId: string, relativePath: string) { return this.filesystem.delete(this.uri(projectId, relativePath)); }
  writeProjectFile(projectId: string, relativePath: string, data: Uint8Array | string, createOnly = false) { return this.filesystem.write(this.uri(projectId, relativePath), typeof data === "string" ? encoder.encode(data) : data, { atomic: true, createOnly }); }
  readProjectFile(projectId: string, relativePath: string) { return this.filesystem.read(this.uri(projectId, relativePath)); }
  async projectFileSize(projectId: string, relativePath: string) { return (await this.filesystem.stat(this.uri(projectId, relativePath))).sizeBytes; }
  async withLock<T>(projectId: string, fn: () => Promise<T>) { for (let attempt = 0; this.locked.has(projectId) && attempt < 200; attempt += 1) await this.clock.sleep(10); if (this.locked.has(projectId)) throw new Error("Project is busy"); this.locked.add(projectId); try { return await fn(); } finally { this.locked.delete(projectId); } }
}
