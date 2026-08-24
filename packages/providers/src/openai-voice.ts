import { openAsBlob } from "node:fs";
import path from "node:path";
import type { VoiceProfile } from "../../core/src/index.js";
import type { OperationContext, TTSResult, VoiceEnrollmentInput, VoiceProvider } from "./contracts.js";

const PRESETS = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"];
const MAX_TTS_INPUT_CHARS = 4_096;
const MAX_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024;

function wavDuration(bytes: Uint8Array): { durationSeconds: number; sampleRate: number } {
  if (bytes.byteLength < 44) throw new Error("OpenAI voice provider returned an invalid WAV file");
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("OpenAI voice provider returned an invalid WAV file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  return { sampleRate, durationSeconds: dataBytes / Math.max(1, sampleRate * channels * (bits / 8)) };
}

function cancelledError(signal?: AbortSignal) { return signal?.reason instanceof Error ? signal.reason : new Error("OpenAI voice request cancelled"); }

export class OpenAIVoiceProvider implements VoiceProvider {
  readonly id = "openai-voice";
  constructor(readonly model = "gpt-4o-mini-tts", private readonly apiKey = process.env.OPENAI_API_KEY, private readonly baseUrl = "https://api.openai.com/v1", private readonly timeoutMs = 120_000) {}
  // Capabilities describe this adapter, not the upstream API. This implementation returns one
  // complete WAV and has no style/emotion parameter in the TTSProvider contract yet.
  capabilities() { return { streaming: false, voiceSelection: true, voiceCloning: true, styleControl: false, speedControl: true, multilingual: true, timestamps: false, phonemeAlignment: false }; }
  voiceCapabilities() { return { tts: true, presetVoices: true, voiceDesign: false, zeroShotClone: true, persistentVoiceProfile: true, crossLingualClone: false, voiceConversion: false, streaming: false, wordTimestamps: false, emotionControl: false, styleControl: false, remoteDeletion: false }; }
  private headers() { if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI voice operations"); return { authorization: `Bearer ${this.apiKey}` }; }
  async listVoices(): Promise<VoiceProfile[]> { return PRESETS.map((voice) => ({ id: `openai-${voice}`, type: "preset", provider: this.id, providerVoiceId: voice, model: this.model, name: voice, languages: ["multilingual"], cloning: false, status: "active", referenceAssetIds: [], authorizationStatus: "not_required", createdAt: new Date(0).toISOString(), usageRestrictions: ["Disclose generated audio as AI-generated", "Availability and usage remain subject to OpenAI terms"], providerMetadata: {} })); }
  private async request(url: string, init: RequestInit, context?: OperationContext) {
    if (context?.signal?.aborted) throw cancelledError(context.signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("OpenAI voice request timed out")), this.timeoutMs);
    const onAbort = () => controller.abort(context?.signal?.reason);
    context?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`${this.baseUrl}${url}`, { ...init, signal: controller.signal });
      if (controller.signal.aborted) throw cancelledError(controller.signal);
      if (!response.ok) throw new Error(`OpenAI voice provider ${response.status}: ${(await response.text()).slice(0, 1000)}`);
      return response;
    } finally { clearTimeout(timer); context?.signal?.removeEventListener("abort", onAbort); }
  }
  async synthesize(input: { text: string; voiceId: string; language: string; speed?: number }, context?: OperationContext): Promise<TTSResult> {
    const text = input.text.trim();
    if (!text) throw new Error("TTS text is required");
    if (text.length > MAX_TTS_INPUT_CHARS) throw new Error(`TTS text exceeds ${MAX_TTS_INPUT_CHARS} characters; split long narration into timeline-sized chunks`);
    if (!input.voiceId.trim()) throw new Error("TTS voiceId is required");
    const speed = input.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error("TTS speed must be between 0.25 and 4");
    context?.onProgress?.(0.05, "voice-request", "Requesting hosted speech");
    const response = await this.request("/audio/speech", { method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify({ model: this.model, input: text, voice: input.voiceId.startsWith("voice_") ? { id: input.voiceId } : input.voiceId, response_format: "wav", speed }) }, context);
    const audio = new Uint8Array(await response.arrayBuffer());
    if (context?.signal?.aborted) throw cancelledError(context.signal);
    const measured = wavDuration(audio);
    context?.onProgress?.(1, "voice-complete", "Hosted speech received");
    return { audio, format: "wav", durationSeconds: measured.durationSeconds, sampleRate: measured.sampleRate, wordTimings: [], model: this.model, voiceId: input.voiceId };
  }
  async enrollVoice(input: VoiceEnrollmentInput, context?: OperationContext) {
    if (!input.providerAuthorizationId?.startsWith("cons_")) throw new Error("OpenAI custom voice enrollment requires an eligible account and providerAuthorizationId consent recording");
    if (context?.signal?.aborted) throw cancelledError(context.signal);
    const sample = await openAsBlob(input.referencePath);
    if (sample.size > MAX_VOICE_SAMPLE_BYTES) throw new Error(`Voice reference exceeds ${MAX_VOICE_SAMPLE_BYTES} bytes`);
    const data = new FormData();
    data.set("name", input.name);
    data.set("consent", input.providerAuthorizationId);
    data.set("audio_sample", sample, path.basename(input.referencePath));
    const response = await this.request("/audio/voices", { method: "POST", headers: this.headers(), body: data }, context);
    const result = await response.json() as { id: string };
    return { providerVoiceId: result.id, model: this.model, providerMetadata: { hosted: true } };
  }
  async health() { if (!this.apiKey) return { id: this.id, status: "unavailable" as const, message: "OPENAI_API_KEY is not configured", capabilities: this.voiceCapabilities() }; try { await this.request(`/models/${encodeURIComponent(this.model)}`, { headers: this.headers() }); return { id: this.id, status: "ready" as const, message: `${this.model} is reachable; custom voices still require account eligibility`, capabilities: this.voiceCapabilities() }; } catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error), capabilities: this.voiceCapabilities() }; } }
}
