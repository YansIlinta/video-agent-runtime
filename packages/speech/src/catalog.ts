export type SpeechRole = "asr" | "tts" | "voice";
export type SpeechCostModel = "free-local" | "paid-api" | "license-restricted";
export type SpeechDeployment = "node-local" | "mobile-local" | "self-hosted" | "hosted-api";
export type SpeechMaturity = "implemented" | "candidate" | "research-only";

export interface SpeechModelDescriptor {
  id: string;
  provider: string;
  role: SpeechRole;
  models: string[];
  cost: SpeechCostModel;
  deployment: SpeechDeployment[];
  languages: string[];
  capabilities: string[];
  licensing: {
    code: string;
    weights: string;
    commercialUse: boolean | "verify";
    notes?: string;
  };
  maturity: SpeechMaturity;
  recommendedFor: string[];
  resourceNotes?: string;
}

/**
 * Product-facing facts only. This list is deliberately small and curated: adding a descriptor does
 * not mean its runtime is bundled or downloaded. Provider implementations remain capability-driven.
 */
export const SPEECH_MODEL_CATALOG: readonly SpeechModelDescriptor[] = [
  {
    id: "asr-qwen3", provider: "Qwen", role: "asr", models: ["Qwen/Qwen3-ASR-0.6B", "Qwen/Qwen3-ASR-1.7B", "Qwen/Qwen3-ForcedAligner-0.6B"],
    cost: "free-local", deployment: ["node-local", "self-hosted"], languages: ["52 languages/dialects"], capabilities: ["language-id", "offline", "streaming-vllm", "forced-alignment", "timestamps", "context-bias"],
    licensing: { code: "Apache-2.0", weights: "Apache-2.0", commercialUse: true }, maturity: "candidate",
    recommendedFor: ["Chinese and Chinese dialects", "multilingual long-form", "local GPU", "edit-safe forced timestamps"], resourceNotes: "0.6B is the practical default to benchmark first; mobile deployment is not claimed.",
  },
  {
    id: "asr-faster-whisper", provider: "faster-whisper", role: "asr", models: ["tiny", "base", "small", "medium", "large-v3"],
    cost: "free-local", deployment: ["node-local", "self-hosted"], languages: ["multilingual"], capabilities: ["word-timestamps", "vad", "language-id"],
    licensing: { code: "MIT", weights: "OpenAI Whisper model terms", commercialUse: "verify", notes: "Verify the selected checkpoint/model artifact terms." }, maturity: "implemented",
    recommendedFor: ["stable local baseline", "word timestamps", "CPU/GPU workstation"],
  },
  {
    id: "asr-sensevoice", provider: "SenseVoice", role: "asr", models: ["SenseVoiceSmall"],
    cost: "free-local", deployment: ["node-local", "mobile-local", "self-hosted"], languages: ["Mandarin", "Cantonese", "English", "Japanese", "Korean", "50+ ecosystem"], capabilities: ["asr", "language-id", "emotion", "audio-events", "ctc-timestamps", "optional-diarization"],
    licensing: { code: "MIT", weights: "FunASR Model Open Source License", commercialUse: "verify", notes: "Official maintainers clarify commercial use is allowed when the model license/attribution terms are followed; converted weights must be checked separately." }, maturity: "candidate",
    recommendedFor: ["fast Chinese ASR", "mobile/edge evaluation", "speech emotion/event metadata"], resourceNotes: "Evaluate official/approved mobile conversion on hardware before shipping.",
  },
  {
    id: "asr-whisper-cpp", provider: "whisper.cpp", role: "asr", models: ["Whisper GGML/GGUF variants"],
    cost: "free-local", deployment: ["node-local", "mobile-local", "self-hosted"], languages: ["multilingual"], capabilities: ["offline", "quantization", "ios", "android", "metal", "cpu"],
    licensing: { code: "MIT", weights: "OpenAI Whisper model terms", commercialUse: "verify" }, maturity: "candidate",
    recommendedFor: ["offline iOS", "offline Android", "low-dependency C/C++"],
  },
  {
    id: "asr-openai", provider: "OpenAI", role: "asr", models: ["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-transcribe-diarize", "whisper-1"],
    cost: "paid-api", deployment: ["hosted-api"], languages: ["multilingual"], capabilities: ["hosted", "diarization", "timestamps-model-dependent", "language-id"],
    licensing: { code: "API", weights: "Hosted", commercialUse: true, notes: "Subject to provider terms and account/model availability." }, maturity: "implemented",
    recommendedFor: ["zero-server BYOK", "speaker diarization", "no local model download"],
  },
  {
    id: "asr-deepgram-nova3", provider: "Deepgram", role: "asr", models: ["nova-3", "nova-3-multilingual"],
    cost: "paid-api", deployment: ["hosted-api"], languages: ["45+ languages"], capabilities: ["diarization", "smart-formatting", "keyterm-prompting", "language-id", "streaming"],
    licensing: { code: "API", weights: "Hosted", commercialUse: true, notes: "Subject to Deepgram terms; diarization can be a separately priced add-on." }, maturity: "candidate",
    recommendedFor: ["cost-sensitive hosted transcription", "production diarization", "streaming"],
  },

  {
    id: "tts-kokoro", provider: "Kokoro", role: "tts", models: ["hexgrad/Kokoro-82M"],
    cost: "free-local", deployment: ["node-local", "self-hosted"], languages: ["multilingual"], capabilities: ["preset-voices", "speed-control", "lightweight"],
    licensing: { code: "Apache-2.0", weights: "Apache-2.0", commercialUse: true, notes: "Voice artifact/pack provenance must still be verified for redistribution." }, maturity: "implemented",
    recommendedFor: ["lightweight local narration", "preset voices", "offline workstation"],
  },
  {
    id: "voice-qwen3-tts", provider: "Qwen", role: "voice", models: ["Qwen/Qwen3-TTS-12Hz-0.6B-Base", "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"],
    cost: "free-local", deployment: ["node-local", "self-hosted"], languages: ["multilingual"], capabilities: ["zero-shot-clone", "cross-lingual-clone", "voice-design", "reusable-clone-prompt", "natural-language-style"],
    licensing: { code: "Apache-2.0", weights: "Apache-2.0", commercialUse: true }, maturity: "candidate",
    recommendedFor: ["authorized voice cloning", "Chinese voice design", "persistent synthetic channel voice"], resourceNotes: "GPU/server first; do not claim mobile-local until measured.",
  },
  {
    id: "voice-cosyvoice3", provider: "CosyVoice", role: "voice", models: ["Fun-CosyVoice3-0.5B"],
    cost: "free-local", deployment: ["node-local", "self-hosted"], languages: ["multilingual", "Chinese dialects"], capabilities: ["zero-shot-clone", "cross-lingual-clone", "instruction-control", "streaming"],
    licensing: { code: "Apache-2.0", weights: "verify exact checkpoint", commercialUse: "verify" }, maturity: "candidate",
    recommendedFor: ["Chinese-first cloning", "dialects", "low-latency server TTS"],
  },
  {
    id: "voice-fish-s2-pro", provider: "Fish Speech", role: "voice", models: ["fishaudio/s2-pro"],
    cost: "license-restricted", deployment: ["node-local", "self-hosted"], languages: ["multilingual"], capabilities: ["voice-clone", "expressive-tags", "long-form-research"],
    licensing: { code: "Fish Audio Research License", weights: "Fish Audio Research License", commercialUse: false, notes: "Do not make this a commercial default without a separate license." }, maturity: "research-only",
    recommendedFor: ["quality benchmark", "research"], resourceNotes: "Official docs recommend at least 24 GB GPU memory for S2 inference.",
  },
  {
    id: "voice-indextts2", provider: "IndexTTS", role: "voice", models: ["IndexTTS2"],
    cost: "license-restricted", deployment: ["node-local", "self-hosted"], languages: ["Chinese", "English", "multilingual depending checkpoint"], capabilities: ["zero-shot-clone", "emotion-control", "duration-control"],
    licensing: { code: "repository-specific", weights: "repository/model terms", commercialUse: "verify", notes: "Upstream asks commercial users to contact the authors; do not label commercial-safe automatically." }, maturity: "research-only",
    recommendedFor: ["clone similarity benchmark", "emotion/timbre separation"],
  },
  {
    id: "voice-f5-tts", provider: "F5-TTS", role: "voice", models: ["F5-TTS"],
    cost: "license-restricted", deployment: ["node-local", "self-hosted"], languages: ["multilingual depending checkpoint"], capabilities: ["zero-shot-tts", "reference-voice"],
    licensing: { code: "MIT", weights: "CC-BY-NC-4.0 official pretrained weights", commercialUse: false }, maturity: "research-only",
    recommendedFor: ["research benchmark", "reference-TTS comparison"],
  },
  {
    id: "voice-openai", provider: "OpenAI", role: "voice", models: ["gpt-4o-mini-tts", "custom voices when account-eligible"],
    cost: "paid-api", deployment: ["hosted-api"], languages: ["multilingual"], capabilities: ["preset-voices", "authorized-custom-voice"],
    licensing: { code: "API", weights: "Hosted", commercialUse: true, notes: "Custom voice creation requires provider eligibility and consent recording; subject to provider terms." }, maturity: "implemented",
    recommendedFor: ["BYOK mobile TTS", "hosted narration", "eligible-account authorized custom voice"],
  },
] as const;

export interface SpeechRecommendationQuery {
  role: SpeechRole;
  localOnly?: boolean;
  mobile?: boolean;
  commercialSafe?: boolean;
  needsClone?: boolean;
  needsDiarization?: boolean;
  language?: string;
}

export function recommendSpeechModels(query: SpeechRecommendationQuery): SpeechModelDescriptor[] {
  const language = query.language?.toLowerCase();
  return SPEECH_MODEL_CATALOG.filter((item) => {
    if (item.role !== query.role) return false;
    if (query.localOnly && !item.deployment.some((target) => target === "node-local" || target === "mobile-local" || target === "self-hosted")) return false;
    if (query.mobile && !item.deployment.includes("mobile-local") && !item.deployment.includes("hosted-api")) return false;
    if (query.commercialSafe && item.licensing.commercialUse !== true) return false;
    if (query.needsClone && !item.capabilities.some((capability) => capability.includes("clone"))) return false;
    if (query.needsDiarization && !item.capabilities.includes("diarization") && !item.capabilities.includes("optional-diarization")) return false;
    if (language && !item.languages.some((value) => value.toLowerCase().includes(language) || value.toLowerCase().includes("multi"))) return false;
    return true;
  }).sort((a, b) => maturityRank(a.maturity) - maturityRank(b.maturity));
}

function maturityRank(value: SpeechMaturity) { return value === "implemented" ? 0 : value === "candidate" ? 1 : 2; }
