import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRuntime } from "../packages/runtime/src/factory.js";
import { loadRuntimeConfig } from "../packages/runtime/src/config.js";

const enabled = process.env.VIDEO_AGENT_REAL_ACCEPTANCE === "true";
const requestedStages = new Set((process.env.VIDEO_AGENT_ACCEPTANCE_STAGES ?? "asr,llm,tts").split(",").map((value) => value.trim()).filter(Boolean));
const validStages = new Set(["asr", "llm", "tts", "clone"]);
for (const stage of requestedStages) if (!validStages.has(stage)) throw new Error(`Unknown acceptance stage ${stage}`);

const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const resultsRoot = path.resolve(process.env.VIDEO_AGENT_ACCEPTANCE_RESULTS ?? "evals/results");
const workspaceRoot = path.resolve(process.env.VIDEO_AGENT_ACCEPTANCE_WORKSPACE ?? path.join(resultsRoot, "workspaces", stamp));
const reportPath = path.resolve(process.env.VIDEO_AGENT_ACCEPTANCE_REPORT ?? path.join(resultsRoot, `real-speech-acceptance-${stamp}.json`));
const fixturePath = path.resolve(process.env.VIDEO_AGENT_ACCEPTANCE_INPUT ?? "evals/real-fixtures/one-speaker.mp4");

interface Measurement<T> {
  status: "passed" | "failed" | "blocked" | "skipped";
  wallMs?: number;
  controllerPeakRssMiB?: number;
  systemGpuPeakUsedMiB?: number;
  value?: T;
  error?: string;
  reason?: string;
}

function errorMessage(error: unknown) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
function mib(bytes: number) { return Math.round((bytes / 1024 / 1024) * 10) / 10; }

function execText(command: string, args: string[], timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function gpuUsedMiB(): Promise<number | undefined> {
  try {
    const text = await execText("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"]);
    const values = text.split(/\r?\n/gu).map((value) => Number(value.trim())).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
  } catch { return undefined; }
}

async function measure<T>(operation: () => Promise<T>): Promise<Measurement<T>> {
  const started = performance.now();
  let peakRss = process.memoryUsage().rss;
  let peakGpu = await gpuUsedMiB();
  let sampling = false;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (sampling) return;
    sampling = true;
    void gpuUsedMiB().then((value) => { if (value !== undefined) peakGpu = Math.max(peakGpu ?? 0, value); }).finally(() => { sampling = false; });
  }, 500);
  timer.unref();
  try {
    const value = await operation();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const finalGpu = await gpuUsedMiB();
    if (finalGpu !== undefined) peakGpu = Math.max(peakGpu ?? 0, finalGpu);
    return { status: "passed", wallMs: Math.round(performance.now() - started), controllerPeakRssMiB: mib(peakRss), ...(peakGpu === undefined ? {} : { systemGpuPeakUsedMiB: peakGpu }), value };
  } catch (error) {
    return { status: "failed", wallMs: Math.round(performance.now() - started), controllerPeakRssMiB: mib(peakRss), ...(peakGpu === undefined ? {} : { systemGpuPeakUsedMiB: peakGpu }), error: errorMessage(error) };
  } finally {
    clearInterval(timer);
  }
}

function blocked(reason: string): Measurement<never> { return { status: "blocked", reason }; }
function skipped(reason: string): Measurement<never> { return { status: "skipped", reason }; }

await mkdir(path.dirname(reportPath), { recursive: true });
await mkdir(workspaceRoot, { recursive: true });

if (!enabled) {
  const report = {
    schemaVersion: 1,
    mode: "disabled",
    requestedStages: [...requestedStages],
    status: "skipped",
    reason: "Set VIDEO_AGENT_REAL_ACCEPTANCE=true to run real provider/model acceptance. No provider call was made.",
    reportPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

// Keep local cloned/designed voice artifacts scoped to the disposable acceptance workspace by default.
process.env.VIDEO_AGENT_QWEN3_TTS_VOICES ??= path.join(workspaceRoot, "provider-voices");
const config = loadRuntimeConfig({ ...process.env, VIDEO_AGENT_WORKSPACE: workspaceRoot }, process.cwd());
const core = createRuntime({ config });
const providerStatus = await core.systemStatus();

const report: Record<string, unknown> = {
  schemaVersion: 1,
  mode: "real-provider",
  startedAt: new Date().toISOString(),
  input: { fixture: path.relative(process.cwd(), fixturePath) || fixturePath },
  workspace: workspaceRoot,
  requestedStages: [...requestedStages],
  providers: {
    asr: { id: core.providers.asr.id, model: core.providers.asr.model, capabilities: core.providers.asr.capabilities() },
    planner: { id: core.providers.planner.id, model: core.providers.planner.model, capabilities: core.providers.planner.capabilities?.() },
    tts: { id: core.providers.tts.id, model: core.providers.tts.model, capabilities: core.providers.tts.capabilities() },
    voice: core.providers.voice ? { id: core.providers.voice.id, model: core.providers.voice.model, capabilities: core.providers.voice.voiceCapabilities() } : undefined,
  },
  providerHealth: providerStatus.checks,
  measurementNotes: {
    controllerPeakRssMiB: "Peak RSS of the Node acceptance controller only; Python/native child-process memory is not included.",
    systemGpuPeakUsedMiB: "Coarse total GPU memory used from nvidia-smi while the stage ran, when available; it is not process-attributed.",
  },
  stages: {},
};

const stages = report.stages as Record<string, Measurement<unknown>>;
let projectId: string | undefined;
let sourceAssetId: string | undefined;
let inputDurationUs: number | undefined;
let transcriptLanguage: string | undefined;
let transcriptSpeakerIds: string[] = [];

async function ensureImported() {
  if (projectId && sourceAssetId) return;
  const created = await core.createProject(`real-speech-acceptance-${stamp}`);
  projectId = created.project.id;
  const asset = await core.importVideo(created.project.id, fixturePath);
  sourceAssetId = asset.id;
  inputDurationUs = asset.metadata.durationUs;
}

if (requestedStages.has("asr")) {
  if (core.providers.asr.id === "fake-asr") stages.asr = blocked("ASR is configured as fake; select faster-whisper, qwen3-asr, or openai.");
  else {
    stages.asr = await measure(async () => {
      await ensureImported();
      const transcript = await core.transcribe(projectId!, sourceAssetId!);
      transcriptLanguage = transcript.language;
      transcriptSpeakerIds = transcript.speakers.map((speaker) => speaker.id);
      const wordCount = transcript.words.length;
      const segmentCount = transcript.segments.length;
      const durationSeconds = (inputDurationUs ?? 0) / 1_000_000;
      return {
        language: transcript.language,
        segmentCount,
        wordCount,
        speakerCount: transcript.speakers.length,
        warnings: transcript.quality.warnings,
        inputDurationSeconds: Math.round(durationSeconds * 1000) / 1000,
      };
    });
    if (stages.asr.status === "passed" && stages.asr.wallMs !== undefined && inputDurationUs) {
      (stages.asr.value as Record<string, unknown>).realTimeFactor = Math.round(((stages.asr.wallMs / 1000) / (inputDurationUs / 1_000_000)) * 1000) / 1000;
    }
  }
}

if (requestedStages.has("llm")) {
  if (core.providers.planner.id === "fake-llm") stages.llm = blocked("Planner is configured as fake; select a production structured-output planner.");
  else if (requestedStages.has("asr") && stages.asr?.status !== "passed") stages.llm = blocked("LLM acceptance depends on a successful real ASR transcript in this run.");
  else {
    stages.llm = await measure(async () => {
      await ensureImported();
      const project = await core.store.readProject(projectId!);
      if (!project.activeTranscriptId) {
        const transcript = await core.transcribe(projectId!, sourceAssetId!);
        transcriptLanguage = transcript.language;
        transcriptSpeakerIds = transcript.speakers.map((speaker) => speaker.id);
      }
      const targetDurationUs = Math.min(inputDurationUs ?? 30_000_000, 30_000_000);
      const strategy = await core.proposeStrategy(projectId!, process.env.VIDEO_AGENT_ACCEPTANCE_EDIT_PROMPT ?? "Create a concise, coherent talking-head edit. Preserve names and numbers and avoid inventing content.", targetDurationUs);
      return {
        strategyId: strategy.id,
        structure: strategy.structure,
        pace: strategy.pace,
        targetDurationSeconds: strategy.targetDurationUs / 1_000_000,
        rationaleCount: strategy.rationale.length,
        status: strategy.status,
      };
    });
  }
}

if (requestedStages.has("tts")) {
  if (core.providers.tts.id === "fake-voice") stages.tts = blocked("TTS is configured as fake; select kokoro, qwen3-tts, or openai.");
  else {
    const configuredVoice = process.env.VIDEO_AGENT_ACCEPTANCE_VOICE_ID;
    const voices = configuredVoice ? [] : await core.providers.tts.listVoices?.() ?? [];
    const selectedVoice = configuredVoice ?? voices[0]?.providerVoiceId;
    if (!selectedVoice) stages.tts = blocked("The selected TTS provider has no preset voice. Set VIDEO_AGENT_ACCEPTANCE_VOICE_ID or run the clone stage to create an authorized voice profile.");
    else {
      stages.tts = await measure(async () => {
        const text = process.env.VIDEO_AGENT_ACCEPTANCE_TTS_TEXT ?? "This is a real speech synthesis acceptance sample for the video editing runtime.";
        const language = process.env.VIDEO_AGENT_ACCEPTANCE_TTS_LANGUAGE ?? (transcriptLanguage?.startsWith("zh") ? "zh" : "en");
        const result = await core.providers.tts.synthesize({ text, voiceId: selectedVoice, language });
        return {
          voiceId: selectedVoice,
          language,
          durationSeconds: Math.round(result.durationSeconds * 1000) / 1000,
          sampleRate: result.sampleRate,
          audioBytes: result.audio.byteLength,
          wordTimingCount: result.wordTimings.length,
        };
      });
      if (stages.tts.status === "passed" && stages.tts.wallMs !== undefined) {
        const duration = Number((stages.tts.value as Record<string, unknown>).durationSeconds ?? 0);
        if (duration > 0) (stages.tts.value as Record<string, unknown>).realTimeFactor = Math.round(((stages.tts.wallMs / 1000) / duration) * 1000) / 1000;
      }
    }
  }
}

if (requestedStages.has("clone")) {
  if (!core.providers.voice?.voiceCapabilities().zeroShotClone || !core.providers.voice.enrollVoice) stages.clone = blocked("Configured voice provider does not expose zero-shot voice enrollment.");
  else if (process.env.VIDEO_AGENT_ACCEPTANCE_AUTHORIZED_VOICE !== "true") stages.clone = blocked("Set VIDEO_AGENT_ACCEPTANCE_AUTHORIZED_VOICE=true only when this fixture/reference voice is authorized for cloning.");
  else if (!process.env.VIDEO_AGENT_ACCEPTANCE_AUTH_GRANTED_BY?.trim() || !process.env.VIDEO_AGENT_ACCEPTANCE_AUTH_EVIDENCE?.trim()) stages.clone = blocked("Authorized clone acceptance requires VIDEO_AGENT_ACCEPTANCE_AUTH_GRANTED_BY and VIDEO_AGENT_ACCEPTANCE_AUTH_EVIDENCE.");
  else if (requestedStages.has("asr") && stages.asr?.status !== "passed") stages.clone = blocked("Voice cloning acceptance depends on a successful transcript-backed ASR run.");
  else {
    stages.clone = await measure(async () => {
      await ensureImported();
      const project = await core.store.readProject(projectId!);
      if (!project.activeTranscriptId) {
        const transcript = await core.transcribe(projectId!, sourceAssetId!);
        transcriptLanguage = transcript.language;
        transcriptSpeakerIds = transcript.speakers.map((speaker) => speaker.id);
      }
      const speakerId = process.env.VIDEO_AGENT_ACCEPTANCE_SPEAKER_ID ?? (transcriptSpeakerIds.length === 1 ? transcriptSpeakerIds[0] : undefined);
      const enrollment = await core.enrollVoice(projectId!, {
        assetId: sourceAssetId!,
        name: "Authorized acceptance voice",
        languages: [process.env.VIDEO_AGENT_ACCEPTANCE_CLONE_LANGUAGE ?? transcriptLanguage ?? "en"],
        authorizationConfirmed: true,
        grantedBy: process.env.VIDEO_AGENT_ACCEPTANCE_AUTH_GRANTED_BY!,
        evidence: process.env.VIDEO_AGENT_ACCEPTANCE_AUTH_EVIDENCE!,
        scope: "real-model-acceptance",
        ...(speakerId ? { speakerId } : {}),
        ...(process.env.VIDEO_AGENT_ACCEPTANCE_PROVIDER_AUTHORIZATION_ID ? { providerAuthorizationId: process.env.VIDEO_AGENT_ACCEPTANCE_PROVIDER_AUTHORIZATION_ID } : {}),
        ...(process.env.VIDEO_AGENT_ACCEPTANCE_ALLOW_EMBEDDING_ONLY === "true" ? { allowEmbeddingOnly: true } : {}),
      });
      await core.approveVoice(projectId!, enrollment.profile.id);
      const generated = await core.generateSpeech(projectId!, {
        voiceProfileId: enrollment.profile.id,
        text: process.env.VIDEO_AGENT_ACCEPTANCE_CLONE_TEXT ?? "This sentence verifies authorized reusable voice generation.",
        language: process.env.VIDEO_AGENT_ACCEPTANCE_CLONE_LANGUAGE ?? transcriptLanguage ?? "en",
        speechType: "cloned_voice",
      });
      return {
        voiceProfileId: enrollment.profile.id,
        authorizationStatus: enrollment.profile.authorizationStatus,
        reference: enrollment.reference,
        quality: {
          speechDurationSeconds: enrollment.quality.speechDurationUs / 1_000_000,
          usableSpeechPercentage: enrollment.quality.usableSpeechPercentage,
          snrDb: enrollment.quality.snrDb,
          clippingRatio: enrollment.quality.clippingRatio,
          silenceRatio: enrollment.quality.silenceRatio,
          reverbScore: enrollment.quality.reverbScore,
        },
        generatedDurationSeconds: generated.durationUs / 1_000_000,
        generatedWordTimingCount: generated.wordTimings.length,
      };
    });
  }
}

for (const stage of validStages) if (!requestedStages.has(stage)) stages[stage] = skipped("Stage not requested.");
const requestedResults = [...requestedStages].map((stage) => stages[stage]);
const failed = requestedResults.some((stage) => stage?.status === "failed");
const blockedRequested = requestedResults.some((stage) => stage?.status === "blocked");
report.finishedAt = new Date().toISOString();
report.status = failed ? "failed" : blockedRequested ? "blocked" : "passed";
report.reportPath = reportPath;

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failed || blockedRequested) process.exitCode = 2;
