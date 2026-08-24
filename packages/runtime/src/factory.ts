import { ProjectStore } from "../../core/src/index.js";
import { FFmpegRenderer, selfCheckPreview } from "../../render/src/index.js";
import { FFmpegVisualEvidenceProvider, probeMedia } from "../../media/src/index.js";
import { createNodeHostProfile } from "../../platform/src/index.js";
import { FakeASRProvider, FakeLLMProvider, FakeVoiceProvider, OpenAILLMProvider, OpenAIVoiceProvider } from "../../providers/src/index.js";
import { FasterWhisperASRProvider, KokoroTTSProvider, WhisperXProvider } from "../../speech/src/index.js";
import { VideoAgentCore } from "./video-agent-core.js";
import { loadRuntimeConfig, loadRuntimeSecrets, type RuntimeConfig } from "./config.js";
import { StructuredLogger } from "./logger.js";

export function createRuntime(options: { workspaceRoot?: string; asrProvider?: "fake" | "faster-whisper"; ttsProvider?: "fake" | "kokoro" | "openai"; plannerProvider?: "fake" | "openai"; config?: RuntimeConfig } = {}): VideoAgentCore {
  const loaded = options.config ?? loadRuntimeConfig();
  const secrets = loadRuntimeSecrets();
  const config: RuntimeConfig = { ...loaded, ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}), providers: { ...loaded.providers, ...(options.asrProvider ? { asr: options.asrProvider } : {}), ...(options.ttsProvider ? { tts: options.ttsProvider } : {}), ...(options.plannerProvider ? { planner: options.plannerProvider } : {}) } };
  const asr = config.providers.asr === "faster-whisper" ? new FasterWhisperASRProvider(config.providers.asrModel, config.executables.python) : new FakeASRProvider();
  const voice = config.providers.tts === "fake" ? new FakeVoiceProvider() : config.providers.tts === "openai" ? new OpenAIVoiceProvider(config.providers.ttsModel, secrets.openaiApiKey) : undefined;
  const tts = config.providers.tts === "kokoro" ? new KokoroTTSProvider(config.providers.ttsModel, config.executables.python) : voice!;
  const planner = config.providers.planner === "openai" ? new OpenAILLMProvider(config.providers.plannerModel, secrets.openaiApiKey) : new FakeLLMProvider();
  const whisperx = config.providers.alignment === "whisperx" || config.providers.diarization === "whisperx" ? new WhisperXProvider("default", config.executables.python, secrets.huggingFaceToken) : undefined;
  const host = createNodeHostProfile(config.workspaceRoot);
  return new VideoAgentCore(new ProjectStore(config.workspaceRoot), { asr, tts, ...(voice ? { voice } : {}), planner, renderer: new FFmpegRenderer(config.executables.ffmpeg), previewSelfCheck: selfCheckPreview, mediaProbe: { probe: (uri) => probeMedia(uri, config.executables.ffprobe) }, visual: new FFmpegVisualEvidenceProvider(config.executables.ffmpeg), ...(config.providers.alignment === "whisperx" && whisperx ? { alignment: whisperx } : {}), ...(config.providers.diarization === "whisperx" && whisperx ? { diarization: whisperx } : {}) }, { ...config.limits, jobMaxAttempts: config.jobs.maxAttempts, baseRetryMs: config.jobs.baseRetryMs }, new StructuredLogger(config.logging.level), host.primitives, host.background);
}
