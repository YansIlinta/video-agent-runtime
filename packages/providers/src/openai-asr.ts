import { openAsBlob } from "node:fs";
import path from "node:path";
import type { ASRCapabilities, ASRProvider, ASRResult, ASRSegmentResult, OperationContext, ProviderHealth } from "./contracts.js";

export type OpenAIASRModel = "gpt-4o-transcribe-diarize" | "whisper-1";

interface DiarizedResponse {
  task?: string;
  duration?: number;
  text?: string;
  segments?: Array<{ id?: string; start: number; end: number; text: string; speaker: string }>;
}

interface WhisperVerboseResponse {
  language?: string;
  duration?: number;
  text?: string;
  segments?: Array<{ id?: number; start: number; end: number; text: string; avg_logprob?: number }>;
  words?: Array<{ start: number; end: number; word: string }>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpga": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

function cancelledError(signal?: AbortSignal) { return signal?.reason instanceof Error ? signal.reason : new Error("OpenAI transcription cancelled"); }
function finiteTimestamp(value: number, label: string) { if (!Number.isFinite(value) || value < 0) throw new Error(`OpenAI transcription returned invalid ${label}`); return value; }

export class OpenAIASRProvider implements ASRProvider {
  readonly id = "openai-asr";
  constructor(readonly model: OpenAIASRModel = "gpt-4o-transcribe-diarize", private readonly apiKey = process.env.OPENAI_API_KEY, private readonly baseUrl = "https://api.openai.com/v1", private readonly timeoutMs = 30 * 60_000) {}

  capabilities(): ASRCapabilities {
    if (this.model === "gpt-4o-transcribe-diarize") return { wordTimestamps: false, segmentTimestamps: true, speakerDiarization: true, languageDetection: false, streaming: false, confidence: false, forcedAlignment: false };
    return { wordTimestamps: true, segmentTimestamps: true, speakerDiarization: false, languageDetection: true, streaming: false, confidence: true, forcedAlignment: false };
  }

  private headers() { if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI ASR"); return { authorization: `Bearer ${this.apiKey}` }; }

  private async fetchWithCancellation(url: string, init: RequestInit, context?: OperationContext): Promise<Response> {
    if (context?.signal?.aborted) throw cancelledError(context.signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("OpenAI transcription timed out")), this.timeoutMs);
    const onAbort = () => controller.abort(context?.signal?.reason);
    context?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (controller.signal.aborted) throw cancelledError(controller.signal);
      return response;
    } finally { clearTimeout(timer); context?.signal?.removeEventListener("abort", onAbort); }
  }

  async transcribe(inputPath: string, options: { language?: string; prompt?: string } = {}, context?: OperationContext): Promise<ASRResult> {
    if (context?.signal?.aborted) throw cancelledError(context.signal);
    const extension = path.extname(inputPath).toLowerCase();
    const blob = await openAsBlob(inputPath, { type: MIME_BY_EXTENSION[extension] ?? "application/octet-stream" });
    const form = new FormData();
    form.set("file", blob, path.basename(inputPath));
    form.set("model", this.model);
    if (options.language) form.set("language", options.language);
    const warnings: string[] = [];

    if (this.model === "gpt-4o-transcribe-diarize") {
      form.set("response_format", "diarized_json");
      form.set("chunking_strategy", "auto");
      if (options.prompt) warnings.push("prompt is not supported by gpt-4o-transcribe-diarize and was not sent");
    } else {
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
      if (options.prompt) form.set("prompt", options.prompt);
    }

    context?.onProgress?.(0.05, "uploading", "Uploading audio for transcription");
    const response = await this.fetchWithCancellation(`${this.baseUrl}/audio/transcriptions`, { method: "POST", headers: this.headers(), body: form }, context);
    const rawText = await response.text();
    if (!response.ok) throw new Error(`OpenAI transcription failed (${response.status}): ${rawText.slice(0, 1_000)}`);
    if (context?.signal?.aborted) throw cancelledError(context.signal);
    context?.onProgress?.(0.9, "normalizing", "Normalizing transcription timestamps");

    let result: ASRResult;
    if (this.model === "gpt-4o-transcribe-diarize") {
      const body = JSON.parse(rawText) as DiarizedResponse;
      const segments: ASRSegmentResult[] = (body.segments ?? []).map((segment) => ({
        text: segment.text.trim(),
        startSeconds: finiteTimestamp(segment.start, "segment start"),
        endSeconds: finiteTimestamp(segment.end, "segment end"),
        speaker: segment.speaker,
        words: [],
      })).filter((segment) => segment.text.length > 0 && segment.endSeconds >= segment.startSeconds);
      if (segments.length === 0 && body.text?.trim()) throw new Error("OpenAI diarized transcription returned text without timestamped segments");
      result = { ...(options.language ? { language: options.language } : {}), segments, warnings };
    } else {
      const body = JSON.parse(rawText) as WhisperVerboseResponse;
      const words = (body.words ?? []).map((word) => ({ text: word.word.trim(), startSeconds: finiteTimestamp(word.start, "word start"), endSeconds: finiteTimestamp(word.end, "word end") })).filter((word) => word.text.length > 0 && word.endSeconds >= word.startSeconds);
      const segments: ASRSegmentResult[] = (body.segments ?? []).map((segment) => {
        const startSeconds = finiteTimestamp(segment.start, "segment start");
        const endSeconds = finiteTimestamp(segment.end, "segment end");
        const confidence = segment.avg_logprob === undefined ? undefined : Math.max(0, Math.min(1, Math.exp(segment.avg_logprob)));
        return { text: segment.text.trim(), startSeconds, endSeconds, ...(confidence === undefined ? {} : { confidence }), words: words.filter((word) => word.startSeconds < endSeconds + 0.001 && word.endSeconds > startSeconds - 0.001) };
      }).filter((segment) => segment.text.length > 0 && segment.endSeconds >= segment.startSeconds);
      if (segments.length === 0 && body.text?.trim()) throw new Error("OpenAI Whisper transcription returned text without timestamped segments");
      result = { ...(body.language ? { language: body.language } : options.language ? { language: options.language } : {}), segments, warnings };
    }

    context?.onProgress?.(1, "complete", "Transcription complete");
    return result;
  }

  async health(): Promise<ProviderHealth> {
    if (!this.apiKey) return { id: this.id, status: "unavailable", message: "OPENAI_API_KEY is not configured", capabilities: { ...this.capabilities() } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${this.baseUrl}/models/${encodeURIComponent(this.model)}`, { headers: this.headers(), signal: controller.signal });
      return { id: this.id, status: response.ok ? "ready" : "degraded", message: response.ok ? `${this.model} is reachable` : `OpenAI model health check returned ${response.status}`, capabilities: { ...this.capabilities() } };
    } catch (error) { return { id: this.id, status: "unavailable", message: error instanceof Error ? error.message : String(error), capabilities: { ...this.capabilities() } }; }
    finally { clearTimeout(timer); }
  }
}
