import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const configSchema = z.object({
  workspaceRoot: z.string(),
  providers: z.object({
    planner: z.enum(["fake", "openai"]),
    plannerModel: z.string(),
    asr: z.enum(["fake", "faster-whisper", "openai"]),
    asrModel: z.string(),
    alignment: z.enum(["none", "whisperx"]),
    diarization: z.enum(["none", "whisperx"]),
    tts: z.enum(["fake", "kokoro", "openai"]),
    ttsModel: z.string(),
  }),
  executables: z.object({ python: z.string(), ffmpeg: z.string(), ffprobe: z.string() }),
  limits: z.object({
    maxInputDurationUs: z.number().int().positive(),
    maxUploadBytes: z.number().int().positive(),
    maxConcurrentJobs: z.number().int().positive(),
    maxFfmpegProcesses: z.number().int().positive(),
    maxAsrJobs: z.number().int().positive(),
    maxGpuJobs: z.number().int().positive(),
    maxPreviewDurationUs: z.number().int().positive(),
    maxDiskBytesPerProject: z.number().int().positive(),
    maxRetainedPreviews: z.number().int().positive(),
  }),
  jobs: z.object({ maxAttempts: z.number().int().positive(), baseRetryMs: z.number().int().nonnegative(), concurrency: z.number().int().positive() }),
  logging: z.object({ level: z.enum(["error", "warn", "info", "debug"]), includeSensitivePaths: z.boolean() }),
});

export type RuntimeConfig = z.infer<typeof configSchema>;
export interface RuntimeSecrets { openaiApiKey?: string; huggingFaceToken?: string; apiBearerToken?: string }

export function loadRuntimeSecrets(env: NodeJS.ProcessEnv = process.env): RuntimeSecrets {
  return { ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}), ...(env.HF_TOKEN ? { huggingFaceToken: env.HF_TOKEN } : {}), ...(env.VIDEO_AGENT_API_TOKEN ? { apiBearerToken: env.VIDEO_AGENT_API_TOKEN } : {}) };
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RuntimeConfig {
  const configPath = env.VIDEO_AGENT_CONFIG ? path.resolve(env.VIDEO_AGENT_CONFIG) : path.resolve(cwd, "video-agent.config.json");
  const fileConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) as Partial<RuntimeConfig> : {};
  const providerFile = fileConfig.providers ?? {} as RuntimeConfig["providers"];
  const executableFile = fileConfig.executables ?? {} as RuntimeConfig["executables"];
  const limitFile = fileConfig.limits ?? {} as RuntimeConfig["limits"];
  const jobFile = fileConfig.jobs ?? {} as RuntimeConfig["jobs"];
  const selectedAsr = env.VIDEO_AGENT_ASR === "faster-whisper" || env.VIDEO_AGENT_ASR === "openai" ? env.VIDEO_AGENT_ASR : providerFile.asr ?? "fake";
  const selectedTts = env.VIDEO_AGENT_TTS === "kokoro" || env.VIDEO_AGENT_TTS === "openai" ? env.VIDEO_AGENT_TTS : providerFile.tts ?? "fake";
  return configSchema.parse({
    workspaceRoot: path.resolve(env.VIDEO_AGENT_WORKSPACE ?? fileConfig.workspaceRoot ?? path.join(cwd, "video-projects")),
    providers: {
      planner: env.VIDEO_AGENT_PLANNER === "openai" ? "openai" : providerFile.planner ?? "fake",
      plannerModel: env.OPENAI_MODEL ?? providerFile.plannerModel ?? "gpt-5.4-mini",
      asr: selectedAsr,
      asrModel: env.VIDEO_AGENT_ASR_MODEL ?? providerFile.asrModel ?? (selectedAsr === "openai" ? "gpt-4o-transcribe-diarize" : "small"),
      alignment: env.VIDEO_AGENT_ALIGNMENT === "whisperx" ? "whisperx" : providerFile.alignment ?? "none",
      diarization: env.VIDEO_AGENT_DIARIZATION === "whisperx" ? "whisperx" : providerFile.diarization ?? "none",
      tts: selectedTts,
      ttsModel: env.VIDEO_AGENT_TTS_MODEL ?? providerFile.ttsModel ?? (selectedTts === "openai" ? "gpt-4o-mini-tts" : "hexgrad/Kokoro-82M"),
    },
    executables: { python: env.VIDEO_AGENT_PYTHON ?? executableFile.python ?? "python", ffmpeg: env.FFMPEG_PATH ?? executableFile.ffmpeg ?? "ffmpeg", ffprobe: env.FFPROBE_PATH ?? executableFile.ffprobe ?? "ffprobe" },
    limits: {
      maxInputDurationUs: numberEnv(env, "VIDEO_AGENT_MAX_INPUT_US", limitFile.maxInputDurationUs ?? 4 * 60 * 60 * 1_000_000),
      maxUploadBytes: numberEnv(env, "VIDEO_AGENT_MAX_UPLOAD_BYTES", limitFile.maxUploadBytes ?? 5 * 1024 ** 3),
      maxConcurrentJobs: numberEnv(env, "VIDEO_AGENT_MAX_CONCURRENT_JOBS", limitFile.maxConcurrentJobs ?? 2),
      maxFfmpegProcesses: numberEnv(env, "VIDEO_AGENT_MAX_FFMPEG", limitFile.maxFfmpegProcesses ?? 1),
      maxAsrJobs: numberEnv(env, "VIDEO_AGENT_MAX_ASR", limitFile.maxAsrJobs ?? 1),
      maxGpuJobs: numberEnv(env, "VIDEO_AGENT_MAX_GPU", limitFile.maxGpuJobs ?? 1),
      maxPreviewDurationUs: numberEnv(env, "VIDEO_AGENT_MAX_PREVIEW_US", limitFile.maxPreviewDurationUs ?? 10 * 60 * 1_000_000),
      maxDiskBytesPerProject: numberEnv(env, "VIDEO_AGENT_MAX_PROJECT_BYTES", limitFile.maxDiskBytesPerProject ?? 20 * 1024 ** 3),
      maxRetainedPreviews: numberEnv(env, "VIDEO_AGENT_MAX_PREVIEWS", limitFile.maxRetainedPreviews ?? 10),
    },
    jobs: { maxAttempts: numberEnv(env, "VIDEO_AGENT_JOB_ATTEMPTS", jobFile.maxAttempts ?? 3), baseRetryMs: Number(env.VIDEO_AGENT_RETRY_MS ?? jobFile.baseRetryMs ?? 250), concurrency: numberEnv(env, "VIDEO_AGENT_JOB_CONCURRENCY", jobFile.concurrency ?? 2) },
    logging: { level: env.VIDEO_AGENT_LOG_LEVEL as RuntimeConfig["logging"]["level"] ?? fileConfig.logging?.level ?? "info", includeSensitivePaths: env.VIDEO_AGENT_LOG_PATHS === "true" || fileConfig.logging?.includeSensitivePaths === true },
  });
}
