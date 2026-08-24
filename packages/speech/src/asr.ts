import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { secondsToUs, type Transcript } from "../../core/src/index.js";
import type { ASRProvider, ASRResult, OperationContext } from "../../providers/src/index.js";
import { runProcess } from "../../media/src/index.js";

export class FasterWhisperASRProvider implements ASRProvider {
  readonly id = "faster-whisper";
  constructor(readonly model = "small", private readonly python = process.env.VIDEO_AGENT_PYTHON ?? "python", private readonly timeoutMs = 3_600_000) {}

  capabilities() {
    return { wordTimestamps: true, segmentTimestamps: true, speakerDiarization: false, languageDetection: true, streaming: false, confidence: true, forcedAlignment: false };
  }

  async transcribe(inputPath: string, options?: { language?: string; prompt?: string }, context?: OperationContext): Promise<ASRResult> {
    const script = path.resolve(import.meta.dirname, "../python/faster_whisper_sidecar.py");
    const args = [script, "--input", path.resolve(inputPath), "--model", this.model];
    if (options?.language) args.push("--language", options.language);
    if (options?.prompt) args.push("--prompt", options.prompt);
    context?.onProgress?.(0.05, "loading-model", `Loading faster-whisper ${this.model}`);
    const result = await runProcess(this.python, args, { timeoutMs: this.timeoutMs, maxOutputBytes: 50 * 1024 * 1024, ...(context?.signal ? { signal: context.signal } : {}) });
    if (result.exitCode !== 0) throw new Error(`Speech provider failed (${result.exitCode}): ${result.stderr.slice(-4000)}`);
    context?.onProgress?.(0.95, "normalizing", "Parsing ASR result");
    try { return JSON.parse(result.stdout) as ASRResult; }
    catch (error) { throw new Error(`Speech provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async health() {
    try { const result = await runProcess(this.python, ["-c", "import faster_whisper; print('ready')"], { timeoutMs: 10_000, maxOutputBytes: 100_000 }); return { id: this.id, status: result.exitCode === 0 ? "ready" as const : "unavailable" as const, message: result.exitCode === 0 ? `${this.model} runtime installed` : result.stderr.slice(-500), capabilities: this.capabilities() }; }
    catch (error) { return { id: this.id, status: "unavailable" as const, message: error instanceof Error ? error.message : String(error), capabilities: this.capabilities() }; }
  }
}

export function normalizeAsrResult(assetId: string, provider: ASRProvider, result: ASRResult, cacheKey: string, rawResultPath?: string): Transcript {
  const words: Transcript["words"] = [];
  const segments: Transcript["segments"] = [];
  const speakers = new Set<string>();
  const failedAlignmentSegmentIds: string[] = [];
  for (const sourceSegment of result.segments) {
    const segmentId = randomUUID();
    const wordIds: string[] = [];
    for (const sourceWord of sourceSegment.words) {
      const id = randomUUID();
      wordIds.push(id);
      if (sourceWord.speaker) speakers.add(sourceWord.speaker);
      const rawText = sourceWord.text;
      const normalizedText = rawText.normalize("NFKC").trim();
      words.push({
        id,
        rawText,
        normalizedText,
        displayText: normalizedText,
        startUs: secondsToUs(sourceWord.startSeconds),
        endUs: secondsToUs(sourceWord.endSeconds),
        timingSource: "asr",
        ...(sourceWord.confidence === undefined ? {} : { confidence: sourceWord.confidence }),
        ...(sourceWord.speaker ? { speakerId: sourceWord.speaker } : {}),
      });
    }
    if (sourceSegment.speaker) speakers.add(sourceSegment.speaker);
    if (sourceSegment.alignmentFailed) failedAlignmentSegmentIds.push(segmentId);
    const rawText = sourceSegment.text;
    const normalizedText = rawText.normalize("NFKC").replace(/\s+/gu, " ").trim();
    segments.push({
      id: segmentId,
      startUs: secondsToUs(sourceSegment.startSeconds),
      endUs: secondsToUs(sourceSegment.endSeconds),
      rawText,
      normalizedText,
      displayText: normalizedText,
      wordIds,
      ...(sourceSegment.speaker ? { speakerId: sourceSegment.speaker } : {}),
      ...(sourceSegment.language ? { language: sourceSegment.language } : {}),
      ...(sourceSegment.confidence === undefined ? {} : { confidence: sourceSegment.confidence }),
    });
  }
  const rawTranscript = result.segments.map((segment) => segment.text).join(" ");
  const normalizedTranscript = rawTranscript.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const silenceRegions = inferSilences(words);
  return {
    schemaVersion: 1,
    id: randomUUID(),
    assetId,
    provider: provider.id,
    model: provider.model,
    ...(result.language ? { language: result.language } : {}),
    ...(result.languageConfidence === undefined ? {} : { languageConfidence: result.languageConfidence }),
    rawTranscript,
    normalizedTranscript,
    displayTranscript: normalizedTranscript,
    words,
    segments,
    speakers: [...speakers].map((id) => ({ id })),
    silenceRegions,
    quality: {
      lowConfidenceWordIds: words.filter((word) => (word.confidence ?? 1) < 0.65).map((word) => word.id),
      unmappedWordIds: [],
      failedAlignmentSegmentIds,
      speakerOverlapRanges: [],
      unknownLanguageSegmentIds: result.language ? [] : segments.map((segment) => segment.id),
      musicHeavyRanges: [],
      longSilenceRanges: silenceRegions.filter((silence) => silence.endUs - silence.startUs >= secondsToUs(2)),
      warnings: result.warnings,
    },
    cacheKey,
    ...(rawResultPath ? { provenance: { rawResultPath } } : {}),
    createdAt: new Date().toISOString(),
  };
}

function inferSilences(words: Transcript["words"]): Array<{ startUs: number; endUs: number; confidence: number }> {
  const sorted = [...words].sort((a, b) => a.startUs - b.startUs);
  const silences: Array<{ startUs: number; endUs: number; confidence: number }> = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current && current.startUs - previous.endUs >= secondsToUs(0.35)) silences.push({ startUs: previous.endUs, endUs: current.startUs, confidence: 0.9 });
  }
  return silences;
}

export function asrCacheKey(assetHash: string, provider: ASRProvider, settings: unknown): string {
  return createHash("sha256").update(JSON.stringify({ assetHash, provider: provider.id, model: provider.model, settings })).digest("hex");
}
