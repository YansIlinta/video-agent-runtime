import type { LogicalUri } from "../../platform/src/contracts.js";

export type MobileOpenAIASRModel = "gpt-4o-transcribe-diarize" | "whisper-1";

/** Narrow native speech boundary: endpoints are pinned in native code; callers cannot upload project media to arbitrary URLs. */
export interface NativeOpenAITranscriptionRequest {
  requestId: string;
  uri: LogicalUri;
  apiKey: string;
  model: MobileOpenAIASRModel;
  language?: string;
  prompt?: string;
  timeoutMs?: number;
}

export interface NativeOpenAITTSRequest {
  requestId: string;
  outputUri: LogicalUri;
  apiKey: string;
  model: string;
  text: string;
  voiceId: string;
  speed?: number;
  timeoutMs?: number;
}

export interface NativeOpenAITTSResult {
  durationSeconds: number;
  sampleRate: number;
  model: string;
  voiceId: string;
}

export interface NativeSpeechHostBridge {
  transcribeOpenAI(request: NativeOpenAITranscriptionRequest): Promise<string>;
  synthesizeOpenAI(request: NativeOpenAITTSRequest): Promise<NativeOpenAITTSResult>;
  cancelTranscription(requestId: string): Promise<void>;
  cancelSynthesis(requestId: string): Promise<void>;
}
