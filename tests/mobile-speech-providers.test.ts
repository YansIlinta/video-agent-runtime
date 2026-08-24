import { describe, expect, it } from "vitest";
import type { HttpAdapter } from "../packages/platform/src/contracts.js";
import type { NativeOpenAITranscriptionRequest, NativeSpeechHostBridge } from "../packages/mobile/src/native-speech-bridge.js";
import { MobileOpenAIASRProvider, MobileOpenAITTSProvider, MutableASRProvider } from "../packages/mobile/src/speech-providers.js";

class FakeHttp implements HttpAdapter {
  constructor(private readonly body = new Uint8Array(), private readonly status = 200) {}
  requests: Parameters<HttpAdapter["request"]>[0][] = [];
  async request(request: Parameters<HttpAdapter["request"]>[0]) { this.requests.push(request); return { status: this.status, headers: {}, body: this.body }; }
}

class FakeSpeechBridge implements NativeSpeechHostBridge {
  requests: NativeOpenAITranscriptionRequest[] = [];
  cancelled: string[] = [];
  response = JSON.stringify({ text: "hello", segments: [{ start: 0, end: 1, text: "hello", speaker: "A" }] });
  pending?: { id: string; reject(error: Error): void };
  waitForCancel = false;
  async transcribeOpenAI(request: NativeOpenAITranscriptionRequest): Promise<string> {
    this.requests.push(request);
    if (!this.waitForCancel) return this.response;
    return new Promise((_resolve, reject) => { this.pending = { id: request.requestId, reject }; });
  }
  async cancelTranscription(requestId: string) { this.cancelled.push(requestId); if (this.pending?.id === requestId) this.pending.reject(new Error("native upload cancelled")); }
}

function wav(durationSeconds = 0.1, sampleRate = 24_000): Uint8Array {
  const dataBytes = Math.round(durationSeconds * sampleRate * 2);
  const bytes = new Uint8Array(44 + dataBytes); const view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, dataBytes, true); return bytes;
}

describe("mobile speech providers", () => {
  it("keeps media on the native ASR bridge and normalizes diarized timestamps", async () => {
    const native = new FakeSpeechBridge(); const http = new FakeHttp();
    const provider = new MobileOpenAIASRProvider("gpt-4o-transcribe-diarize", "sk-test", native, http);
    const result = await provider.transcribe("project://p/assets/interview.mp4", { language: "zh" });
    expect(native.requests).toHaveLength(1);
    expect(native.requests[0]).toMatchObject({ uri: "project://p/assets/interview.mp4", model: "gpt-4o-transcribe-diarize" });
    expect(result.segments[0]).toMatchObject({ text: "hello", startSeconds: 0, endSeconds: 1, speaker: "A" });
    expect(provider.capabilities()).toMatchObject({ speakerDiarization: true, wordTimestamps: false });
  });

  it("maps whisper word timestamps without an O(segments × words) full rescan", async () => {
    const native = new FakeSpeechBridge(); native.response = JSON.stringify({ language: "en", text: "hello world again", segments: [{ start: 0, end: 1.2, text: "hello world", avg_logprob: -0.1 }, { start: 1.2, end: 2, text: "again", avg_logprob: -0.2 }], words: [{ start: 0, end: 0.4, word: "hello" }, { start: 0.5, end: 1, word: "world" }, { start: 1.3, end: 1.8, word: "again" }] });
    const provider = new MobileOpenAIASRProvider("whisper-1", "sk-test", native, new FakeHttp()); const result = await provider.transcribe("project://p/assets/a.mp4");
    expect(result.segments.map((segment) => segment.words.map((word) => word.text))).toEqual([["hello", "world"], ["again"]]);
    expect(provider.capabilities()).toMatchObject({ wordTimestamps: true, speakerDiarization: false });
  });

  it("propagates cancellation to the native upload instead of only cancelling durable state", async () => {
    const native = new FakeSpeechBridge(); native.waitForCancel = true; const provider = new MobileOpenAIASRProvider("whisper-1", "sk-test", native, new FakeHttp()); const controller = new AbortController();
    const pending = provider.transcribe("project://p/assets/a.mp4", {}, { signal: controller.signal });
    await Promise.resolve(); controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow(/cancel/i); expect(native.cancelled).toHaveLength(1); expect(native.cancelled[0]).toBe(native.requests[0]?.requestId);
  });

  it("keeps mutable ASR identity unavailable until a real provider is configured", async () => {
    const mutable = new MutableASRProvider(); expect(mutable.id).toBe("mobile-asr-unavailable"); await expect(mutable.transcribe("project://p/a.mp4")).rejects.toThrow(/not implemented on this host/i);
    const provider = new MobileOpenAIASRProvider("whisper-1", "sk-test", new FakeSpeechBridge(), new FakeHttp()); mutable.set(provider); expect(mutable.id).toBe(provider.id); expect(mutable.model).toBe("whisper-1");
  });

  it("generates bounded WAV TTS with capabilities matching the actual adapter", async () => {
    const http = new FakeHttp(wav()); const provider = new MobileOpenAITTSProvider("gpt-4o-mini-tts", "sk-test", http);
    const result = await provider.synthesize({ text: "hello", voiceId: "alloy", language: "en" }); expect(result.durationSeconds).toBeCloseTo(0.1); expect(result.sampleRate).toBe(24_000);
    expect(provider.capabilities()).toEqual({ streaming: false, voiceSelection: true, voiceCloning: false, styleControl: false, speedControl: true, multilingual: true, timestamps: false, phonemeAlignment: false });
    await expect(provider.synthesize({ text: "x".repeat(4_097), voiceId: "alloy", language: "en" })).rejects.toThrow(/split narration/i);
    expect(http.requests).toHaveLength(1);
  });
});
