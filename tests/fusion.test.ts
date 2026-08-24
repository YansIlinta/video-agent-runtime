import { describe, expect, it } from "vitest";
import { fuseTranscript } from "../packages/speech/src/index.js";
import type { Transcript } from "../packages/core/src/index.js";

const now = new Date().toISOString();
const transcript: Transcript = { schemaVersion: 1, id: "t", assetId: "a", provider: "fake", model: "v1", language: "en", rawTranscript: "Hello world", normalizedTranscript: "Hello world", displayTranscript: "Hello world", words: [
  { id: "w1", rawText: "Hello", normalizedText: "Hello", displayText: "Hello", startUs: 0, endUs: 400_000, timingSource: "asr" },
  { id: "w2", rawText: "world", normalizedText: "world", displayText: "world", startUs: 500_000, endUs: 900_000, timingSource: "asr" },
], segments: [{ id: "s", startUs: 0, endUs: 900_000, rawText: "Hello world", normalizedText: "Hello world", displayText: "Hello world", wordIds: ["w1", "w2"] }], speakers: [], silenceRegions: [], quality: { lowConfidenceWordIds: [], unmappedWordIds: [], failedAlignmentSegmentIds: [], speakerOverlapRanges: [], unknownLanguageSegmentIds: [], musicHeavyRanges: [], longSilenceRanges: [], warnings: [] }, cacheKey: "key", createdAt: now };

describe("transcript fusion", () => {
  it("maps aligned timings and diarization without discarding raw evidence", () => {
    const fused = fuseTranscript(transcript, { provider: "align", model: "m", words: [{ rawText: "hello", startUs: 10_000, endUs: 410_000 }, { rawText: "world", startUs: 430_000, endUs: 850_000 }], failedSegmentIds: [], warnings: [] }, { provider: "diarize", model: "d", segments: [{ speakerId: "speaker-a", startUs: 0, endUs: 900_000 }], warnings: [] });
    expect(fused.rawTranscript).toBe(transcript.rawTranscript);
    expect(fused.words.map((word) => word.timingSource)).toEqual(["aligned", "aligned"]);
    expect(fused.words.every((word) => word.speakerId === "speaker-a")).toBe(true);
    expect(fused.quality.unmappedWordIds).toEqual([]);
  });
});
