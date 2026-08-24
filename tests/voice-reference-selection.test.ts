import { describe, expect, it } from "vitest";
import type { Transcript, VoiceReferenceQualityReport } from "../packages/core/src/schemas.js";
import { selectVoiceReference } from "../packages/runtime/src/voice-reference-selection.js";
import { Qwen3VoiceProvider } from "../packages/speech/src/qwen3-tts.js";

function transcript(): Transcript {
  return {
    schemaVersion: 1,
    id: "transcript-1",
    assetId: "asset-1",
    provider: "fixture",
    model: "fixture",
    language: "en",
    rawTranscript: "hello there this is a clean reference second speaker",
    normalizedTranscript: "hello there this is a clean reference second speaker",
    displayTranscript: "hello there this is a clean reference second speaker",
    words: [
      { id: "w1", rawText: "hello ", normalizedText: "hello", displayText: "hello", startUs: 1_000_000, endUs: 2_000_000, timingSource: "aligned", confidence: 0.98, speakerId: "A" },
      { id: "w2", rawText: "there ", normalizedText: "there", displayText: "there", startUs: 2_000_000, endUs: 3_000_000, timingSource: "aligned", confidence: 0.98, speakerId: "A" },
      { id: "w3", rawText: "this ", normalizedText: "this", displayText: "this", startUs: 3_000_000, endUs: 4_000_000, timingSource: "aligned", confidence: 0.98, speakerId: "A" },
      { id: "w4", rawText: "is ", normalizedText: "is", displayText: "is", startUs: 4_000_000, endUs: 5_000_000, timingSource: "aligned", confidence: 0.98, speakerId: "A" },
      { id: "w5", rawText: "a ", normalizedText: "a", displayText: "a", startUs: 5_000_000, endUs: 6_000_000, timingSource: "aligned", confidence: 0.98, speakerId: "A" },
      { id: "w6", rawText: "clean ", normalizedText: "clean", displayText: "clean", startUs: 6_000_000, endUs: 7_000_000, timingSource: "aligned", confidence: 0.98, speakerId: "A" },
      { id: "w7", rawText: "reference", normalizedText: "reference", displayText: "reference", startUs: 7_000_000, endUs: 8_000_000, timingSource: "aligned", confidence: 0.98, speakerId: "A" },
      { id: "w8", rawText: "second speaker", normalizedText: "second speaker", displayText: "second speaker", startUs: 8_500_000, endUs: 10_000_000, timingSource: "aligned", confidence: 0.9, speakerId: "B" },
    ],
    segments: [
      { id: "s1", startUs: 1_000_000, endUs: 8_000_000, rawText: "hello there this is a clean reference", normalizedText: "hello there this is a clean reference", displayText: "hello there this is a clean reference", wordIds: ["w1", "w2", "w3", "w4", "w5", "w6", "w7"], speakerId: "A", language: "en", confidence: 0.98 },
      { id: "s2", startUs: 8_500_000, endUs: 10_000_000, rawText: "second speaker", normalizedText: "second speaker", displayText: "second speaker", wordIds: ["w8"], speakerId: "B", language: "en", confidence: 0.9 },
    ],
    speakers: [{ id: "A" }, { id: "B" }],
    silenceRegions: [],
    quality: { lowConfidenceWordIds: [], unmappedWordIds: [], failedAlignmentSegmentIds: [], speakerOverlapRanges: [], unknownLanguageSegmentIds: [], musicHeavyRanges: [], longSilenceRanges: [], warnings: [] },
    cacheKey: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function quality(candidates: VoiceReferenceQualityReport["candidates"]): VoiceReferenceQualityReport {
  return {
    id: "quality-1", projectId: "project-1", assetId: "asset-1", assetSha256: "a".repeat(64), analysisVersion: "test", speechDurationUs: 9_000_000,
    snrDb: 30, clippingRatio: 0, musicProbability: 0, reverbScore: 0, speakerCount: 2, silenceRatio: 0.1, speakerConsistency: 0.95, asrConfidence: 0.97, usableSpeechPercentage: 90,
    candidates, warnings: [], cacheKey: "quality", createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("voice reference selection", () => {
  it("selects a bounded single-speaker range and exact transcript text", () => {
    const selected = selectVoiceReference(transcript(), quality([{ startUs: 1_000_000, endUs: 8_000_000, score: 0.95, reasons: ["clean"] }]), "A");
    expect(selected).toMatchObject({ startUs: 1_000_000, endUs: 8_000_000, speakerId: "A", segmentIds: ["s1"] });
    expect(selected?.referenceText).toBe("hello there this is a clean reference");
  });

  it("requires explicit speaker selection when the transcript contains multiple speakers", () => {
    expect(() => selectVoiceReference(transcript(), quality([{ startUs: 1_000_000, endUs: 8_000_000, score: 1, reasons: [] }]), undefined)).toThrow(/speakerId is required/i);
  });

  it("rejects a selected-speaker range that crosses another known speaker", () => {
    const selected = selectVoiceReference(transcript(), quality([{ startUs: 5_000_000, endUs: 10_000_000, score: 1, reasons: ["bad mixed range"] }]), "A");
    expect(selected).toBeUndefined();
  });

  it("fails clearly when a requested speaker is absent", () => {
    expect(() => selectVoiceReference(transcript(), quality([{ startUs: 1_000_000, endUs: 8_000_000, score: 1, reasons: [] }]), "missing")).toThrow(/not present/i);
  });

  it("requires explicit opt-in before Qwen can fall back to embedding-only cloning", async () => {
    const provider = new Qwen3VoiceProvider();
    expect(provider.cloneReferencePolicy()).toMatchObject({ highQualityRequiresReferenceText: true, embeddingOnlySupported: true, minDurationSeconds: 3, maxDurationSeconds: 15 });
    await expect(provider.enrollVoice({
      name: "test", referencePath: "/does/not/matter.wav", referenceAssetId: "asset-1", languages: ["en"],
      authorization: { grantedBy: "test", grantedAt: "2026-01-01T00:00:00.000Z", evidence: "explicit fixture authorization", scope: "test" },
    })).rejects.toThrow(/referenceText|embedding-only/i);
  });
});
