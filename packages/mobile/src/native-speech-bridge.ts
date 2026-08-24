import type { LogicalUri } from "../../platform/src/contracts.js";

export type MobileOpenAIASRModel = "gpt-4o-transcribe-diarize" | "whisper-1";

/**
 * Narrow native boundary for large speech uploads. It intentionally does not accept an arbitrary
 * URL: exposing a generic "upload local file" primitive would let a misconfigured provider send
 * private project media to any host. Native implementations pin the request to OpenAI's official
 * transcription endpoint and stream the file without moving media bytes through React Native JS.
 */
export interface NativeOpenAITranscriptionRequest {
  requestId: string;
  uri: LogicalUri;
  apiKey: string;
  model: MobileOpenAIASRModel;
  language?: string;
  prompt?: string;
  timeoutMs?: number;
}

export interface NativeSpeechHostBridge {
  transcribeOpenAI(request: NativeOpenAITranscriptionRequest): Promise<string>;
  cancelTranscription(requestId: string): Promise<void>;
}
