import { describe, expect, it } from "vitest";
import type { ASRResult } from "../packages/providers/src/contracts.js";
import {
  planSpeechSegmentTiming,
  translateAsrResult,
  type StructuredTextGenerator,
} from "../packages/speech/src/speech-pipeline.js";

const asr: ASRResult = {
  language: "Chinese",
  warnings: [],
  segments: [
    { text: "你好。", startSeconds: 0, endSeconds: 1, words: [] },
    { text: "这是一个测试。", startSeconds: 1, endSeconds: 2.5, words: [] },
  ],
};

function generator(value: unknown): StructuredTextGenerator {
  return {
    id: "fake-text-generator",
    model: "fake",
    async generateStructured(request: { schema: { parse(value: unknown): unknown } }) {
      return {
        value: request.schema.parse(value),
        metadata: {
          id: "call-1",
          operation: "speech-transform",
          provider: "fake",
          model: "fake",
          latencyMs: 0,
          retryCount: 0,
          validation: { valid: true, issues: [] },
          status: "succeeded",
          createdAt: new Date(0).toISOString(),
        },
      } as never;
    },
  } as unknown as StructuredTextGenerator;
}

describe("speech-only translation", () => {
  it("preserves one translated result per ASR segment", async () => {
    const result = await translateAsrResult(asr, generator({
      sourceLanguage: "Chinese",
      targetLanguage: "English",
      segments: [
        { index: 0, targetText: "Hello." },
        { index: 1, targetText: "This is a test." },
      ],
    }), { targetLanguage: "English" });

    expect(result.targetLanguage).toBe("English");
    expect(result.segments.map((segment) => segment.index)).toEqual([0, 1]);
    expect(result.segments.map((segment) => segment.targetText)).toEqual(["Hello.", "This is a test."]);
  });

  it("rejects a model response that changes segment cardinality", async () => {
    await expect(translateAsrResult(asr, generator({
      sourceLanguage: "Chinese",
      targetLanguage: "English",
      segments: [{ index: 0, targetText: "Merged translation." }],
    }), { targetLanguage: "English" })).rejects.toThrow("changed segment count");
  });
});

describe("speech timing plan", () => {
  it("preserves source silence before a segment", () => {
    expect(planSpeechSegmentTiming(2, 3, 0.6, 0)).toEqual({
      gapBeforeSeconds: 2,
      targetDurationSeconds: 1,
      playbackRate: 1,
      renderedStartSeconds: 2,
      renderedEndSeconds: 3,
      delayedBySeconds: 0,
    });
  });

  it("compresses speech only when generated audio is longer than the source slot", () => {
    const timing = planSpeechSegmentTiming(1, 2.2, 2.4, 1);
    expect(timing.targetDurationSeconds).toBeCloseTo(1.2);
    expect(timing.playbackRate).toBeCloseTo(2);
    expect(timing.renderedEndSeconds).toBeCloseTo(2.2);
  });

  it("makes overlapping single-track segments explicit instead of silently losing timeline state", () => {
    const timing = planSpeechSegmentTiming(1.5, 2.5, 1, 2);
    expect(timing.gapBeforeSeconds).toBe(0);
    expect(timing.renderedStartSeconds).toBe(2);
    expect(timing.delayedBySeconds).toBeCloseTo(0.5);
    expect(timing.renderedEndSeconds).toBe(3);
  });

  it("rejects invalid generated durations", () => {
    expect(() => planSpeechSegmentTiming(0, 1, 0, 0)).toThrow("Generated speech duration must be positive");
  });
});
