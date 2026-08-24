import { randomUUID } from "node:crypto";
import { rangesOverlap, type AlignmentResult, type DiarizationResult, type Transcript } from "../../core/src/index.js";

function normalizeToken(value: string): string { return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }

export function fuseTranscript(base: Transcript, alignment?: AlignmentResult, diarization?: DiarizationResult): Transcript {
  const aligned = alignment?.words ?? [];
  let cursor = 0;
  const unmappedWordIds: string[] = [];
  const words = base.words.map((word) => {
    let matchedIndex = -1;
    for (let index = cursor; index < Math.min(aligned.length, cursor + 8); index += 1) if (normalizeToken(aligned[index]!.rawText) === normalizeToken(word.rawText)) { matchedIndex = index; break; }
    const timing = matchedIndex >= 0 ? aligned[matchedIndex]! : undefined;
    if (timing) cursor = matchedIndex + 1; else if (alignment) unmappedWordIds.push(word.id);
    const startUs = timing?.startUs ?? word.startUs; const endUs = timing?.endUs ?? word.endUs;
    const speakerMatches = diarization?.segments.filter((segment) => rangesOverlap(startUs, endUs, segment.startUs, segment.endUs)) ?? [];
    const speaker = speakerMatches.sort((a, b) => (Math.min(endUs, b.endUs) - Math.max(startUs, b.startUs)) - (Math.min(endUs, a.endUs) - Math.max(startUs, a.startUs)))[0];
    return { ...word, startUs, endUs, timingSource: timing ? "aligned" as const : word.timingSource, ...(timing?.confidence === undefined ? {} : { confidence: timing.confidence }), ...(speaker ? { speakerId: speaker.speakerId } : {}) };
  });
  const wordById = new Map(words.map((word) => [word.id, word]));
  const segments = base.segments.map((segment) => {
    const segmentWords = segment.wordIds.map((id) => wordById.get(id)).filter((word) => word !== undefined);
    const speakers = new Map<string, number>();
    for (const word of segmentWords) if (word.speakerId) speakers.set(word.speakerId, (speakers.get(word.speakerId) ?? 0) + (word.endUs - word.startUs));
    const speakerId = [...speakers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { ...segment, ...(segmentWords[0] ? { startUs: segmentWords[0].startUs, endUs: segmentWords.at(-1)!.endUs } : {}), ...(speakerId ? { speakerId } : {}) };
  });
  const overlapRanges: Array<{ startUs: number; endUs: number }> = [];
  const diarized = diarization?.segments ?? [];
  for (let i = 0; i < diarized.length; i += 1) for (let j = i + 1; j < diarized.length; j += 1) if (diarized[i]!.speakerId !== diarized[j]!.speakerId && rangesOverlap(diarized[i]!.startUs, diarized[i]!.endUs, diarized[j]!.startUs, diarized[j]!.endUs)) overlapRanges.push({ startUs: Math.max(diarized[i]!.startUs, diarized[j]!.startUs), endUs: Math.min(diarized[i]!.endUs, diarized[j]!.endUs) });
  const speakerIds = [...new Set(words.map((word) => word.speakerId).filter((value): value is string => Boolean(value)))];
  return { ...base, id: randomUUID(), words, segments, speakers: speakerIds.map((id) => ({ id })), quality: { ...base.quality, unmappedWordIds, failedAlignmentSegmentIds: alignment?.failedSegmentIds ?? base.quality.failedAlignmentSegmentIds, speakerOverlapRanges: overlapRanges, warnings: [...base.quality.warnings, ...(alignment?.warnings ?? []), ...(diarization?.warnings ?? [])] }, provenance: { ...base.provenance, ...(alignment ? { alignmentProvider: `${alignment.provider}/${alignment.model}` } : {}), ...(diarization ? { diarizationProvider: `${diarization.provider}/${diarization.model}` } : {}) }, createdAt: new Date().toISOString() };
}
