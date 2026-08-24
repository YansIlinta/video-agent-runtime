import { describe, expect, it } from "vitest";
import { SPEECH_MODEL_CATALOG, recommendSpeechModels } from "../packages/speech/src/catalog.js";

describe("speech model catalog", () => {
  it("tracks at least five serious ASR and voice/TTS candidates without loading runtimes", () => {
    expect(SPEECH_MODEL_CATALOG.filter((item) => item.role === "asr").length).toBeGreaterThanOrEqual(5);
    expect(SPEECH_MODEL_CATALOG.filter((item) => item.role === "tts" || item.role === "voice").length).toBeGreaterThanOrEqual(5);
  });

  it("does not recommend research-only voice models for commercial-safe cloning", () => {
    const values = recommendSpeechModels({ role: "voice", needsClone: true, commercialSafe: true, localOnly: true });
    expect(values.map((item) => item.id)).toContain("voice-qwen3-tts");
    expect(values.map((item) => item.id)).not.toContain("voice-fish-s2-pro");
    expect(values.map((item) => item.id)).not.toContain("voice-f5-tts");
  });

  it("keeps mobile selection honest", () => {
    const values = recommendSpeechModels({ role: "asr", mobile: true });
    expect(values.map((item) => item.id)).toContain("asr-whisper-cpp");
    expect(values.map((item) => item.id)).toContain("asr-openai");
    expect(values.map((item) => item.id)).not.toContain("asr-qwen3");
  });
});
