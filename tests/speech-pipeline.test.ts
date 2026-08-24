import { describe, expect, it } from "vitest";
import type { ASRResult } from "../packages/providers/src/contracts.js";
import {
  buildDubbingFilterGraph,
  translateAsrResult,
  type StructuredTextGenerator,
  type SynthesizedSpeechSegment,
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

  it("places synthesized speech on the original ASR timeline", () => {
    const segments: SynthesizedSpeechSegment[] = [
      {
        index: 0,
        sourceStartSeconds: 0.5,
        sourceEndSeconds: 1.5,
        sourceText: "你好。",
        targetText: "Hello there.",
        audioPath: "/tmp/segment-0000.wav",
        generatedDurationSeconds: 2,
      },
      {
        index: 1,
        sourceStartSeconds: 2,
        sourceEndSeconds: 3.5,
        sourceText: "这是一个测试。",
        targetText: "This is a test.",
        audioPath: "/tmp/segment-0001.wav",
        generatedDurationSeconds: 1,
      },
    ];

    const graph = buildDubbingFilterGraph(segments);

    expect(graph).toContain("[0:a]");
    expect(graph).toContain("atempo=2");
    expect(graph).toContain("atrim=duration=1");
    expect(graph).toContain("adelay=500:all=1");
    expect(graph).toContain("atrim=duration=1.5");
    expect(graph).toContain("adelay=2000:all=1");
    expect(graph).toContain("amix=inputs=2:duration=longest");
  });
});
