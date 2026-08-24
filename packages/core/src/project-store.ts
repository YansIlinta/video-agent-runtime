import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  assetSchema,
  diagnosisSchema,
  editPatchSchema,
  editPlanSchema,
  editingStrategySchema,
  feedbackSchema,
  projectSchema,
  projectVersionSchema,
  speechAssetSchema,
  jobSchema,
  jobEventSchema,
  providerCallSchema,
  visualEvidenceSchema,
  voiceProfileSchema,
  voiceReferenceQualityReportSchema,
  voiceDeletionEventSchema,
  timelineSchema,
  transcriptSchema,
  workflowRunSchema,
  type Asset,
  type Diagnosis,
  type EditPatch,
  type EditPlan,
  type EditingStrategy,
  type Feedback,
  type Project,
  type ProjectVersion,
  type SpeechAsset,
  type Job,
  type JobEvent,
  type ProviderCall,
  type VisualEvidence,
  type VoiceProfile,
  type VoiceReferenceQualityReport,
  type VoiceDeletionEvent,
  type Timeline,
  type Transcript,
  type WorkflowRun,
} from "./schemas.js";

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{2,100}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function assertContained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes workspace: ${candidate}`);
  return resolved;
}

async function readJson<T>(filePath: string, schema: { parse(value: unknown): T }): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { const text = await readFile(filePath, "utf8"); return schema.parse(JSON.parse(text)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 4) {
        const backup = `${filePath}.bak`;
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && await exists(backup)) return schema.parse(JSON.parse(await readFile(backup, "utf8")));
        throw error;
      }
      await sleep(5);
    }
  }
  throw new Error(`Unable to read ${filePath}`);
}

async function recoverAtomicFile(filePath: string): Promise<void> {
  const backup = `${filePath}.bak`;
  if (!(await exists(filePath)) && (await exists(backup))) await rename(backup, filePath);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${filePath}.bak`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (await exists(filePath)) {
    await rm(backup, { force: true });
    await rename(filePath, backup);
  }
  try {
    await rename(temp, filePath);
    await rm(backup, { force: true });
  } catch (error) {
    if (!(await exists(filePath)) && (await exists(backup))) await rename(backup, filePath);
    await rm(temp, { force: true });
    throw error;
  }
}

export class ProjectStore {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.workspaceRoot, { recursive: true });
  }

  async listProjectIds(): Promise<string[]> {
    await this.initialize();
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name)).map((entry) => entry.name).sort();
  }

  async projectDiskUsage(projectId: string): Promise<number> {
    const pending = [this.projectRoot(projectId)]; let total = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(candidate);
        else if (entry.isFile()) total += (await stat(candidate)).size;
      }
    }
    return total;
  }

  async prunePreviews(projectId: string, retain: number): Promise<string[]> {
    const directory = this.file(projectId, "previews");
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mp4")).map(async (entry) => ({ path: path.join(directory, entry.name), mtimeMs: (await stat(path.join(directory, entry.name))).mtimeMs })));
    const removeFiles = files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(Math.max(0, retain));
    await Promise.all(removeFiles.map((entry) => rm(entry.path, { force: true })));
    return removeFiles.map((entry) => path.basename(entry.path));
  }

  async sweepTemporaryFiles(projectId: string): Promise<string[]> {
    const removed: string[] = [];
    for (const relativeDirectory of ["tmp", "previews", "exports", "analysis/visual"] as const) {
      const directory = this.file(projectId, relativeDirectory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !(entry.name.endsWith(".tmp") || entry.name.includes(".tmp.mp4") || entry.name.endsWith(".captions.srt"))) continue;
        await rm(path.join(directory, entry.name), { force: true }); removed.push(`${relativeDirectory}/${entry.name}`);
      }
    }
    return removed;
  }

  projectRoot(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error(`Invalid project id: ${projectId}`);
    return assertContained(this.workspaceRoot, path.join(this.workspaceRoot, projectId));
  }

  private file(projectId: string, relativePath: string): string {
    return assertContained(this.projectRoot(projectId), path.join(this.projectRoot(projectId), relativePath));
  }

  async create(name: string): Promise<{ project: Project; timeline: Timeline; workflow: WorkflowRun; root: string }> {
    await this.initialize();
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "video";
    const projectId = `${slug}-${randomUUID().slice(0, 8)}`;
    const root = this.projectRoot(projectId);
    const directories = ["assets", "derived", "transcripts", "analysis", "analysis/raw", "analysis/visual", "analysis/voice", "edits/plans", "edits/patches", "edits/strategies", "edits/versions", "previews", "exports", "feedback", "workflow", "speech", "voices", "voices/profiles", "voices/references", "voices/derived", "voices/deletions", "jobs", "events", "provider-calls", "tmp"];
    await Promise.all(directories.map((directory) => mkdir(path.join(root, directory), { recursive: true })));
    const now = new Date().toISOString();
    const timeline: Timeline = {
      schemaVersion: 1,
      id: randomUUID(),
      projectId,
      frameRate: { numerator: 30, denominator: 1 },
      width: 1080,
      height: 1920,
      durationUs: 0,
      tracks: [],
      updatedAt: now,
    };
    const workflow: WorkflowRun = { schemaVersion: 1, id: randomUUID(), projectId, state: "CREATED", steps: [], updatedAt: now };
    const project: Project = {
      schemaVersion: 1,
      id: projectId,
      name,
      createdAt: now,
      updatedAt: now,
      assets: [],
      activeVersion: 0,
      workflowRunId: workflow.id,
    };
    await atomicWriteJson(path.join(root, "project.json"), projectSchema.parse(project));
    await atomicWriteJson(path.join(root, "edits", "timeline.json"), timelineSchema.parse(timeline));
    await atomicWriteJson(path.join(root, "workflow", "run.json"), workflowRunSchema.parse(workflow));
    return { project, timeline, workflow, root };
  }

  async readProject(projectId: string): Promise<Project> {
    const file = this.file(projectId, "project.json");
    await recoverAtomicFile(file);
    return readJson(file, projectSchema);
  }

  async writeProject(project: Project): Promise<void> {
    const parsed = projectSchema.parse({ ...project, updatedAt: new Date().toISOString() });
    await atomicWriteJson(this.file(project.id, "project.json"), parsed);
  }

  async readTimeline(projectId: string): Promise<Timeline> {
    const file = this.file(projectId, "edits/timeline.json");
    await recoverAtomicFile(file);
    return readJson(file, timelineSchema);
  }

  async writeTimeline(projectId: string, timeline: Timeline): Promise<void> {
    await atomicWriteJson(this.file(projectId, "edits/timeline.json"), timelineSchema.parse(timeline));
  }

  async readWorkflow(projectId: string): Promise<WorkflowRun> {
    const file = this.file(projectId, "workflow/run.json");
    await recoverAtomicFile(file);
    return readJson(file, workflowRunSchema);
  }

  async writeWorkflow(projectId: string, workflow: WorkflowRun): Promise<void> {
    await atomicWriteJson(this.file(projectId, "workflow/run.json"), workflowRunSchema.parse(workflow));
  }

  async writeTranscript(projectId: string, transcript: Transcript): Promise<void> {
    await atomicWriteJson(this.file(projectId, `transcripts/${transcript.id}.json`), transcriptSchema.parse(transcript));
  }

  async readTranscript(projectId: string, transcriptId: string): Promise<Transcript> {
    return readJson(this.file(projectId, `transcripts/${path.basename(transcriptId)}.json`), transcriptSchema);
  }

  async findTranscriptByCacheKey(projectId: string, cacheKey: string): Promise<Transcript | undefined> {
    const directory = this.file(projectId, "transcripts");
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    for (const name of names) {
      const transcript = await readJson(path.join(directory, name), transcriptSchema);
      if (transcript.cacheKey === cacheKey) return transcript;
    }
    return undefined;
  }

  async writeStrategy(projectId: string, strategy: EditingStrategy): Promise<void> {
    await atomicWriteJson(this.file(projectId, `edits/strategies/${strategy.id}.json`), editingStrategySchema.parse(strategy));
  }

  async readStrategy(projectId: string, strategyId: string): Promise<EditingStrategy> {
    return readJson(this.file(projectId, `edits/strategies/${path.basename(strategyId)}.json`), editingStrategySchema);
  }

  async writeEditPlan(projectId: string, plan: EditPlan): Promise<void> {
    await atomicWriteJson(this.file(projectId, `edits/plans/${plan.id}.json`), editPlanSchema.parse(plan));
  }

  async readEditPlan(projectId: string, planId: string): Promise<EditPlan> {
    return readJson(this.file(projectId, `edits/plans/${path.basename(planId)}.json`), editPlanSchema);
  }

  async writeEditPatch(projectId: string, patch: EditPatch): Promise<void> {
    await atomicWriteJson(this.file(projectId, `edits/patches/${patch.id}.json`), editPatchSchema.parse(patch));
  }

  async readEditPatch(projectId: string, patchId: string): Promise<EditPatch> {
    return readJson(this.file(projectId, `edits/patches/${path.basename(patchId)}.json`), editPatchSchema);
  }

  async writeVersion(projectId: string, version: ProjectVersion): Promise<void> {
    await atomicWriteJson(this.file(projectId, `edits/versions/v${version.version}.json`), projectVersionSchema.parse(version));
  }

  async readVersion(projectId: string, version: number): Promise<ProjectVersion> {
    return readJson(this.file(projectId, `edits/versions/v${version}.json`), projectVersionSchema);
  }

  async tryReadVersion(projectId: string, version: number): Promise<ProjectVersion | undefined> {
    try { return await this.readVersion(projectId, version); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async listVersions(projectId: string): Promise<ProjectVersion[]> {
    const directory = this.file(projectId, "edits/versions");
    const names = (await readdir(directory)).filter((name) => /^v\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
    return Promise.all(names.map((name) => readJson(path.join(directory, name), projectVersionSchema)));
  }

  async writeFeedback(projectId: string, feedback: Feedback): Promise<void> {
    await atomicWriteJson(this.file(projectId, `feedback/${feedback.id}.json`), feedbackSchema.parse(feedback));
  }

  async readFeedback(projectId: string, feedbackId: string): Promise<Feedback> {
    return readJson(this.file(projectId, `feedback/${path.basename(feedbackId)}.json`), feedbackSchema);
  }

  async listFeedback(projectId: string): Promise<Feedback[]> {
    const directory = this.file(projectId, "feedback");
    const names = (await readdir(directory)).filter((name) => !name.startsWith("diagnosis-") && name.endsWith(".json"));
    const items = await Promise.all(names.map((name) => readJson(path.join(directory, name), feedbackSchema)));
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async writeDiagnosis(projectId: string, diagnosis: Diagnosis): Promise<void> {
    await atomicWriteJson(this.file(projectId, `feedback/diagnosis-${diagnosis.id}.json`), diagnosisSchema.parse(diagnosis));
  }

  async writeSpeechAsset(projectId: string, speechAsset: SpeechAsset): Promise<void> {
    await atomicWriteJson(this.file(projectId, `speech/${speechAsset.id}.json`), speechAssetSchema.parse(speechAsset));
  }

  async findSpeechAssetByCacheKey(projectId: string, cacheKey: string): Promise<SpeechAsset | undefined> {
    const directory = this.file(projectId, "speech");
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    for (const name of names) {
      const speech = await readJson(path.join(directory, name), speechAssetSchema);
      if (speech.cacheKey === cacheKey && await exists(this.file(projectId, `derived/${speech.id}.wav`))) return speech;
    }
    return undefined;
  }

  async readSpeechAsset(projectId: string, speechAssetId: string): Promise<SpeechAsset> { return readJson(this.file(projectId, `speech/${path.basename(speechAssetId)}.json`), speechAssetSchema); }
  async listSpeechAssets(projectId: string): Promise<SpeechAsset[]> { const directory = this.file(projectId, "speech"); const names = (await readdir(directory)).filter((name) => name.endsWith(".json")); return Promise.all(names.map((name) => readJson(path.join(directory, name), speechAssetSchema))); }

  async writeVoiceProfile(projectId: string, profile: VoiceProfile): Promise<void> { const target = this.file(projectId, `voices/profiles/${profile.id}.json`); await mkdir(path.dirname(target), { recursive: true }); await atomicWriteJson(target, voiceProfileSchema.parse(profile)); }
  async readVoiceProfile(projectId: string, profileId: string): Promise<VoiceProfile> { return readJson(this.file(projectId, `voices/profiles/${path.basename(profileId)}.json`), voiceProfileSchema); }
  async listVoiceProfiles(projectId: string, includeDeleted = false): Promise<VoiceProfile[]> { const directory = this.file(projectId, "voices/profiles"); await mkdir(directory, { recursive: true }); const names = (await readdir(directory)).filter((name) => name.endsWith(".json")); const profiles = await Promise.all(names.map((name) => readJson(path.join(directory, name), voiceProfileSchema))); return profiles.filter((profile) => includeDeleted || profile.status !== "deleted"); }
  async writeVoiceReferenceQuality(projectId: string, report: VoiceReferenceQualityReport): Promise<void> { const target = this.file(projectId, `analysis/voice/${report.id}.json`); await mkdir(path.dirname(target), { recursive: true }); await atomicWriteJson(target, voiceReferenceQualityReportSchema.parse(report)); }
  async findVoiceReferenceQualityByCacheKey(projectId: string, cacheKey: string): Promise<VoiceReferenceQualityReport | undefined> { const directory = this.file(projectId, "analysis/voice"); await mkdir(directory, { recursive: true }); const names = (await readdir(directory)).filter((name) => name.endsWith(".json")); for (const name of names) { const report = await readJson(path.join(directory, name), voiceReferenceQualityReportSchema); if (report.cacheKey === cacheKey) return report; } return undefined; }
  async writeVoiceDeletionEvent(projectId: string, event: VoiceDeletionEvent): Promise<void> { const target = this.file(projectId, `voices/deletions/${event.createdAt.replace(/[:.]/g, "-")}-${event.id}.json`); await mkdir(path.dirname(target), { recursive: true }); await atomicWriteJson(target, voiceDeletionEventSchema.parse(event)); }
  async removeProjectFile(projectId: string, relativePath: string): Promise<void> { await rm(this.file(projectId, relativePath), { force: true, recursive: false }); }
  async writeProjectFile(projectId: string, relativePath: string, data: Uint8Array | string, createOnly = false): Promise<void> { const target = this.file(projectId, relativePath); await mkdir(path.dirname(target), { recursive: true }); await import("node:fs/promises").then((fs) => fs.writeFile(target, data, { flag: createOnly ? "wx" : "w" })); }
  async readProjectFile(projectId: string, relativePath: string): Promise<Uint8Array> { return new Uint8Array(await readFile(this.file(projectId, relativePath))); }
  async projectFileSize(projectId: string, relativePath: string): Promise<number> { return (await stat(this.file(projectId, relativePath))).size; }

  async writeJob(projectId: string, job: Job): Promise<void> {
    await atomicWriteJson(this.file(projectId, `jobs/${job.id}.json`), jobSchema.parse(job));
  }

  async readJob(projectId: string, jobId: string): Promise<Job> {
    return readJson(this.file(projectId, `jobs/${path.basename(jobId)}.json`), jobSchema);
  }

  async listJobs(projectId: string): Promise<Job[]> {
    const directory = this.file(projectId, "jobs");
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const jobs = await Promise.all(names.map((name) => readJson(path.join(directory, name), jobSchema)));
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async writeJobEvent(projectId: string, event: JobEvent): Promise<void> {
    await atomicWriteJson(this.file(projectId, `events/${event.createdAt.replace(/[:.]/g, "-")}-${event.id}.json`), jobEventSchema.parse(event));
  }

  async writeProviderCall(projectId: string, call: ProviderCall): Promise<void> {
    await atomicWriteJson(this.file(projectId, `provider-calls/${call.id}.json`), providerCallSchema.parse(call));
  }

  async writeVisualEvidence(projectId: string, evidence: VisualEvidence): Promise<void> {
    await atomicWriteJson(this.file(projectId, `analysis/visual/${evidence.id}.json`), visualEvidenceSchema.parse(evidence));
  }

  async listVisualEvidence(projectId: string): Promise<VisualEvidence[]> {
    const directory = this.file(projectId, "analysis/visual");
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    return Promise.all(names.map((name) => readJson(path.join(directory, name), visualEvidenceSchema)));
  }

  async copySourceAsset(projectId: string, sourcePath: string, maxBytes: number): Promise<{ relativePath: string; sha256: string; sizeBytes: number }> {
    const source = path.resolve(sourcePath);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("Source media must be a regular file");
    if (sourceStat.size > maxBytes) throw new Error(`Source media exceeds ${maxBytes} byte limit`);
    const safeName = path.basename(source).replace(/[^a-zA-Z0-9._-]+/g, "-");
    const relativePath = `assets/${randomUUID()}-${safeName}`;
    const destination = this.file(projectId, relativePath);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const sha256 = await sha256File(destination);
    return { relativePath, sha256, sizeBytes: sourceStat.size };
  }

  resolveProjectFile(projectId: string, relativePath: string): string {
    return this.file(projectId, relativePath);
  }

  async withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.file(projectId, ".project.lock");
    let handle;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await sleep(25);
      }
    }
    if (!handle) throw new Error("Project is busy");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return await fn();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}
