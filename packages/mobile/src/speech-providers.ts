import type { VoiceProfile } from "../../core/src/schemas.js";
import type { ASRCapabilities, ASRProvider, ASRResult, ASRSegmentResult, OperationContext, ProviderHealth, TTSFileResult, TTSInput, TTSProvider, TTSResult } from "../../providers/src/contracts.js";
import type { HttpAdapter } from "../../platform/src/contracts.js";
import type { MobileOpenAIASRModel, NativeSpeechHostBridge } from "./native-speech-bridge.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_TTS_TEXT_CHARS = 4_096;
const MAX_TTS_RESPONSE_BYTES = 32 * 1024 * 1024;
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"] as const;
const fallbackId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface DiarizedResponse { text?: string; segments?: Array<{ start: number; end: number; text: string; speaker: string }> }
interface WhisperVerboseResponse { language?: string; text?: string; segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number }>; words?: Array<{ start: number; end: number; word: string }> }

function finiteTimestamp(value: number, label: string) { if (!Number.isFinite(value) || value < 0) throw new Error(`OpenAI transcription returned invalid ${label}`); return value; }
function cancellation(signal?: AbortSignal) { return signal?.reason instanceof Error ? signal.reason : new Error("Speech request cancelled"); }
function officialOpenAIBase(baseUrl: string) { const normalized = baseUrl.replace(/\/+$/u, ""); if (normalized !== OPENAI_BASE_URL) throw new Error("Mobile speech is pinned to https://api.openai.com/v1; arbitrary media endpoints are intentionally not supported"); return normalized; }
function apiVoiceId(voiceId: string) { return voiceId.startsWith("openai-") ? voiceId.slice("openai-".length) : voiceId; }
function validateTtsInput(input: TTSInput) {
  if (!input.text.trim()) throw new Error("TTS text cannot be empty");
  if (input.text.length > MAX_TTS_TEXT_CHARS) throw new Error(`TTS text exceeds ${MAX_TTS_TEXT_CHARS} characters; split narration into timeline-sized chunks`);
}

function normalizeTranscription(model: MobileOpenAIASRModel, rawText: string, options: { language?: string; prompt?: string }): ASRResult {
  const warnings: string[] = [];
  if (model === "gpt-4o-transcribe-diarize") {
    if (options.prompt) warnings.push("prompt is not supported by gpt-4o-transcribe-diarize and was not sent");
    const body = JSON.parse(rawText) as DiarizedResponse;
    const segments: ASRSegmentResult[] = (body.segments ?? []).map((segment) => ({ text: segment.text.trim(), startSeconds: finiteTimestamp(segment.start, "segment start"), endSeconds: finiteTimestamp(segment.end, "segment end"), speaker: segment.speaker, words: [] })).filter((segment) => segment.text.length > 0 && segment.endSeconds > segment.startSeconds);
    if (segments.length === 0 && body.text?.trim()) throw new Error("OpenAI diarized transcription returned text without timestamped segments");
    return { ...(options.language ? { language: options.language } : {}), segments, warnings };
  }

  const body = JSON.parse(rawText) as WhisperVerboseResponse;
  const words = (body.words ?? []).map((word) => ({ text: word.word.trim(), startSeconds: finiteTimestamp(word.start, "word start"), endSeconds: finiteTimestamp(word.end, "word end") })).filter((word) => word.text.length > 0 && word.endSeconds > word.startSeconds);
  let wordCursor = 0; const segments: ASRSegmentResult[] = [];
  for (const source of body.segments ?? []) {
    const startSeconds = finiteTimestamp(source.start, "segment start"); const endSeconds = finiteTimestamp(source.end, "segment end");
    if (!source.text.trim() || endSeconds <= startSeconds) continue;
    while (wordCursor < words.length && words[wordCursor]!.endSeconds <= startSeconds - 0.001) wordCursor += 1;
    const segmentWords: typeof words = [];
    for (let index = wordCursor; index < words.length && words[index]!.startSeconds < endSeconds + 0.001; index += 1) if (words[index]!.endSeconds > startSeconds - 0.001) segmentWords.push(words[index]!);
    const confidence = source.avg_logprob === undefined ? undefined : Math.max(0, Math.min(1, Math.exp(source.avg_logprob)));
    segments.push({ text: source.text.trim(), startSeconds, endSeconds, ...(confidence === undefined ? {} : { confidence }), words: segmentWords });
  }
  if (segments.length === 0 && body.text?.trim()) throw new Error("OpenAI Whisper transcription returned text without timestamped segments");
  return { ...(body.language ? { language: body.language } : options.language ? { language: options.language } : {}), segments, warnings };
}

export class MobileOpenAIASRProvider implements ASRProvider {
  readonly id = "openai-asr-mobile";
  constructor(readonly model: MobileOpenAIASRModel, private readonly apiKey: string | undefined, private readonly native: NativeSpeechHostBridge, private readonly http: HttpAdapter, baseUrl = OPENAI_BASE_URL, private readonly createRequestId: () => string = fallbackId) { officialOpenAIBase(baseUrl); }
  capabilities(): ASRCapabilities { return this.model === "gpt-4o-transcribe-diarize" ? { wordTimestamps: false, segmentTimestamps: true, speakerDiarization: true, languageDetection: false, streaming: false, confidence: false, forcedAlignment: false } : { wordTimestamps: true, segmentTimestamps: true, speakerDiarization: false, languageDetection: true, streaming: false, confidence: true, forcedAlignment: false }; }
  private key() { if (!this.apiKey) throw new Error("OpenAI API key is required for mobile ASR"); return this.apiKey; }
  async transcribe(inputPath: string, options: { language?: string; prompt?: string } = {}, context?: OperationContext): Promise<ASRResult> {
    if (context?.signal?.aborted) throw cancellation(context.signal);
    if (!inputPath.startsWith("project://")) throw new Error("Mobile ASR accepts only durable project:// assets");
    const requestId = `asr-${this.createRequestId()}`;
    const onAbort = () => { void this.native.cancelTranscription(requestId); };
    context?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      context?.onProgress?.(0.02, "uploading", "Streaming project media to speech recognition");
      const raw = await this.native.transcribeOpenAI({ requestId, uri: inputPath as `project://${string}`, apiKey: this.key(), model: this.model, ...(options.language ? { language: options.language } : {}), ...(options.prompt && this.model === "whisper-1" ? { prompt: options.prompt } : {}), timeoutMs: 30 * 60_000 });
      if (context?.signal?.aborted) throw cancellation(context.signal);
      context?.onProgress?.(0.92, "normalizing", "Normalizing speech timestamps"); const result = normalizeTranscription(this.model, raw, options); context?.onProgress?.(1, "complete", "Transcription complete"); return result;
    } finally { context?.signal?.removeEventListener("abort", onAbort); }
  }
  async health(): Promise<ProviderHealth> {
    if (!this.apiKey) return { id: this.id, status: "unavailable", message: "OpenAI API key is not configured", capabilities: { ...this.capabilities() } };
    try { const response = await this.http.request({ method: "GET", url: `${OPENAI_BASE_URL}/models/${encodeURIComponent(this.model)}`, headers: { authorization: `Bearer ${this.apiKey}` }, timeoutMs: 5_000 }); return { id: this.id, status: response.status >= 200 && response.status < 300 ? "ready" : "degraded", message: response.status >= 200 && response.status < 300 ? `${this.model} is reachable` : `Model check returned ${response.status}`, capabilities: { ...this.capabilities() } }; }
    catch (error) { return { id: this.id, status: "unavailable", message: error instanceof Error ? error.message : String(error), capabilities: { ...this.capabilities() } }; }
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number) { return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
function wavDuration(bytes: Uint8Array): { durationSeconds: number; sampleRate: number } {
  if (bytes.byteLength < 44 || readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") throw new Error("OpenAI TTS returned an invalid WAV file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 12; let channels = 0; let sampleRate = 0; let bitsPerSample = 0; let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) { const id = readAscii(bytes, offset, 4); const size = view.getUint32(offset + 4, true); const body = offset + 8; if (body + size > bytes.byteLength) break; if (id === "fmt " && size >= 16) { channels = view.getUint16(body + 2, true); sampleRate = view.getUint32(body + 4, true); bitsPerSample = view.getUint16(body + 14, true); } if (id === "data") { dataBytes = size; break; } offset = body + size + (size % 2); }
  if (!channels || !sampleRate || !bitsPerSample || !dataBytes) throw new Error("OpenAI TTS WAV is missing fmt/data chunks");
  return { sampleRate, durationSeconds: dataBytes / Math.max(1, sampleRate * channels * (bitsPerSample / 8)) };
}

export class MobileOpenAITTSProvider implements TTSProvider {
  readonly id = "openai-tts-mobile";
  constructor(readonly model = "gpt-4o-mini-tts", private readonly apiKey: string | undefined, private readonly native: NativeSpeechHostBridge, private readonly http: HttpAdapter, private readonly baseUrl = OPENAI_BASE_URL, private readonly createRequestId: () => string = fallbackId) { officialOpenAIBase(baseUrl); }
  capabilities() { return { streaming: false, voiceSelection: true, voiceCloning: false, styleControl: false, speedControl: true, multilingual: true, timestamps: false, phonemeAlignment: false }; }
  private key() { if (!this.apiKey) throw new Error("OpenAI API key is required for mobile TTS"); return this.apiKey; }
  async listVoices(): Promise<VoiceProfile[]> { return OPENAI_VOICES.map((voice) => ({ id: `openai-${voice}`, type: "preset", provider: this.id, providerVoiceId: voice, model: this.model, name: voice, languages: ["multilingual"], cloning: false, status: "active", referenceAssetIds: [], authorizationStatus: "not_required", createdAt: new Date(0).toISOString(), usageRestrictions: ["Disclose generated audio as AI-generated", "Availability and use remain subject to provider terms"], providerMetadata: {} })); }
  async synthesizeToFile(input: TTSInput & { outputUri: string }, context?: OperationContext): Promise<TTSFileResult> {
    if (context?.signal?.aborted) throw cancellation(context.signal); validateTtsInput(input);
    if (!input.outputUri.startsWith("project://")) throw new Error("Mobile TTS output must be a durable project:// URI");
    const requestId = `tts-${this.createRequestId()}`; const voiceId = apiVoiceId(input.voiceId);
    const onAbort = () => { void this.native.cancelSynthesis(requestId); }; context?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      context?.onProgress?.(0.05, "tts-request", "Generating narration directly to project storage");
      const result = await this.native.synthesizeOpenAI({ requestId, outputUri: input.outputUri as `project://${string}`, apiKey: this.key(), model: this.model, text: input.text, voiceId, ...(input.speed === undefined ? {} : { speed: input.speed }), timeoutMs: 120_000 });
      if (context?.signal?.aborted) throw cancellation(context.signal);
      context?.onProgress?.(1, "tts-complete", "Narration generated");
      return { format: "wav", durationSeconds: result.durationSeconds, sampleRate: result.sampleRate, wordTimings: [], model: result.model, voiceId: result.voiceId };
    } finally { context?.signal?.removeEventListener("abort", onAbort); }
  }
  /** Byte-returning fallback kept for provider-level tests and non-Core callers. Core uses synthesizeToFile on mobile. */
  async synthesize(input: TTSInput, context?: OperationContext): Promise<TTSResult> {
    if (context?.signal?.aborted) throw cancellation(context.signal); validateTtsInput(input); const voiceId = apiVoiceId(input.voiceId);
    context?.onProgress?.(0.05, "tts-request", "Generating narration");
    const response = await this.http.request({ method: "POST", url: `${this.baseUrl}/audio/speech`, headers: { authorization: `Bearer ${this.key()}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.model, input: input.text, voice: voiceId, response_format: "wav", speed: input.speed ?? 1 }), timeoutMs: 120_000, ...(context?.signal ? { signal: context.signal } : {}) });
    if (response.status < 200 || response.status >= 300) throw new Error(`OpenAI TTS failed (${response.status}): ${new TextDecoder().decode(response.body.slice(0, 1_000))}`); if (response.body.byteLength > MAX_TTS_RESPONSE_BYTES) throw new Error(`TTS response exceeds ${MAX_TTS_RESPONSE_BYTES} bytes; use shorter narration chunks`); if (context?.signal?.aborted) throw cancellation(context.signal);
    const measured = wavDuration(response.body); context?.onProgress?.(1, "tts-complete", "Narration generated"); return { audio: response.body, format: "wav", durationSeconds: measured.durationSeconds, sampleRate: measured.sampleRate, wordTimings: [], model: this.model, voiceId };
  }
  async health(): Promise<ProviderHealth> {
    if (!this.apiKey) return { id: this.id, status: "unavailable", message: "OpenAI API key is not configured", capabilities: { ...this.capabilities() } };
    try { const response = await this.http.request({ method: "GET", url: `${this.baseUrl}/models/${encodeURIComponent(this.model)}`, headers: { authorization: `Bearer ${this.apiKey}` }, timeoutMs: 5_000 }); return { id: this.id, status: response.status >= 200 && response.status < 300 ? "ready" : "degraded", message: response.status >= 200 && response.status < 300 ? `${this.model} is reachable` : `Model check returned ${response.status}`, capabilities: { ...this.capabilities() } }; }
    catch (error) { return { id: this.id, status: "unavailable", message: error instanceof Error ? error.message : String(error), capabilities: { ...this.capabilities() } }; }
  }
}

export class MutableASRProvider implements ASRProvider {
  get id() { return this.current?.id ?? "mobile-asr-unavailable"; } get model() { return this.current?.model ?? "not-integrated"; }
  private current?: ASRProvider;
  set(provider: ASRProvider) { this.current = provider; }
  configured() { return this.current !== undefined; }
  private provider() { if (!this.current) throw new Error("On-device transcription is not implemented on this host. Configure an ASR provider before proposing an edit."); return this.current; }
  capabilities(): ASRCapabilities { return this.current?.capabilities() ?? { wordTimestamps: false, segmentTimestamps: false, speakerDiarization: false, languageDetection: false, streaming: false, confidence: false, forcedAlignment: false }; }
  async transcribe(inputPath: string, options?: { language?: string; prompt?: string }, context?: OperationContext) { return this.provider().transcribe(inputPath, options, context); }
  health() { return this.current?.health?.() ?? Promise.resolve({ id: this.id, status: "unavailable" as const, message: "ASR provider is not configured", capabilities: { ...this.capabilities() } }); }
}

export class MutableTTSProvider implements TTSProvider {
  get id() { return this.current?.id ?? "mobile-tts-unavailable"; } get model() { return this.current?.model ?? "not-integrated"; }
  private current?: TTSProvider;
  set(provider: TTSProvider) { this.current = provider; }
  configured() { return this.current !== undefined; }
  private provider() { if (!this.current) throw new Error("Configure a TTS provider before speech generation"); return this.current; }
  capabilities() { return this.current?.capabilities() ?? { streaming: false, voiceSelection: false, voiceCloning: false, styleControl: false, speedControl: false, multilingual: false, timestamps: false, phonemeAlignment: false }; }
  listVoices() { return this.current?.listVoices?.() ?? Promise.resolve([]); }
  synthesize(input: TTSInput, context?: OperationContext) { return this.provider().synthesize(input, context); }
  get synthesizeToFile(): TTSProvider["synthesizeToFile"] { const provider = this.current; return provider?.synthesizeToFile ? provider.synthesizeToFile.bind(provider) : undefined; }
  health() { return this.current?.health?.() ?? Promise.resolve({ id: this.id, status: "unavailable" as const, message: "TTS provider is not configured", capabilities: { ...this.capabilities() } }); }
}
