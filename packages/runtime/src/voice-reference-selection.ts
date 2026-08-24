import type { Transcript, VoiceReferenceQualityReport } from "../../core/src/schemas.js";
import type { VoiceCloneReferencePolicy } from "../../providers/src/contracts.js";

export interface VoiceReferenceSelection {
  startUs: number;
  endUs: number;
  referenceText: string;
  speakerId?: string;
  segmentIds: string[];
  score: number;
}

function overlaps(startA: number, endA: number, startB: number, endB: number) { return startA < endB && startB < endA; }
function overlapUs(startA: number, endA: number, startB: number, endB: number) { return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB)); }

function joinWordText(words: Transcript["words"]): string {
  const raw = words.map((word) => word.rawText).join("").trim();
  if (!raw) return "";
  const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(raw);
  if (hasCjk || /\s/u.test(raw)) return raw.replace(/\s+/gu, " ").trim();
  return words.map((word) => word.rawText.trim()).filter(Boolean).join(" ");
}

function exactTextForRange(transcript: Transcript, startUs: number, endUs: number, speakerId?: string) {
  const selectedWords = transcript.words
    .filter((word) => word.startUs >= startUs && word.endUs <= endUs && (!speakerId || !word.speakerId || word.speakerId === speakerId))
    .sort((a, b) => a.startUs - b.startUs);
  if (selectedWords.length > 0) {
    const text = joinWordText(selectedWords);
    if (text) return { text, startUs: selectedWords[0]!.startUs, endUs: selectedWords.at(-1)!.endUs };
  }

  const contained = transcript.segments.filter((segment) => segment.startUs >= startUs && segment.endUs <= endUs && (!speakerId || !segment.speakerId || segment.speakerId === speakerId));
  if (contained.length === 1) {
    const segment = contained[0]!;
    const text = segment.rawText.trim();
    if (text) return { text, startUs: segment.startUs, endUs: segment.endUs };
  }
  return undefined;
}

/**
 * Pick a bounded, transcript-backed, single-speaker reference. The returned text is derived only
 * from words/segments entirely inside the extracted range, so an ICL clone never receives text
 * describing audio that is not actually present in the reference clip.
 */
export function selectVoiceReference(
  transcript: Transcript,
  quality: VoiceReferenceQualityReport,
  speakerId: string | undefined,
  policy: VoiceCloneReferencePolicy = { minDurationSeconds: 3, maxDurationSeconds: 15, highQualityRequiresReferenceText: true, embeddingOnlySupported: false },
): VoiceReferenceSelection | undefined {
  if (transcript.assetId !== quality.assetId) return undefined;
  const transcriptSpeakers = new Set(transcript.segments.map((segment) => segment.speakerId).filter((value): value is string => Boolean(value)));
  if (!speakerId && transcriptSpeakers.size > 1) throw new Error("Multiple speakers are present in the active transcript; speakerId is required for voice enrollment");
  if (speakerId && !transcript.segments.some((segment) => segment.speakerId === speakerId)) throw new Error(`Speaker ${speakerId} is not present in the active transcript`);

  const minUs = Math.max(1, policy.minDurationSeconds * 1_000_000);
  const maxUs = Math.max(minUs, policy.maxDurationSeconds * 1_000_000);
  const ranked: VoiceReferenceSelection[] = [];

  for (const candidate of [...quality.candidates].sort((a, b) => b.score - a.score)) {
    const requestedStart = candidate.startUs;
    const requestedEnd = Math.min(candidate.endUs, candidate.startUs + maxUs);
    if (requestedEnd <= requestedStart) continue;

    const overlappingSegments = transcript.segments.filter((segment) => overlaps(requestedStart, requestedEnd, segment.startUs, segment.endUs));
    const knownSpeakers = new Set(overlappingSegments.map((segment) => segment.speakerId).filter((value): value is string => Boolean(value)));
    if (speakerId && knownSpeakers.size > 0 && [...knownSpeakers].some((value) => value !== speakerId)) continue;
    if (!speakerId && knownSpeakers.size > 1) continue;
    const resolvedSpeaker = speakerId ?? [...knownSpeakers][0];

    const exact = exactTextForRange(transcript, requestedStart, requestedEnd, resolvedSpeaker);
    if (!exact || !exact.text.trim()) continue;
    const durationUs = exact.endUs - exact.startUs;
    if (durationUs < minUs || durationUs > maxUs) continue;

    const conflictingSpeaker = transcript.segments.some((segment) => segment.speakerId && resolvedSpeaker && segment.speakerId !== resolvedSpeaker && overlapUs(exact.startUs, exact.endUs, segment.startUs, segment.endUs) >= 100_000);
    if (conflictingSpeaker) continue;

    const segments = overlappingSegments
      .filter((segment) => overlapUs(exact.startUs, exact.endUs, segment.startUs, segment.endUs) > 0 && (!resolvedSpeaker || !segment.speakerId || segment.speakerId === resolvedSpeaker));
    if (segments.length === 0) continue;
    const averageConfidence = segments.reduce((sum, segment) => sum + (segment.confidence ?? quality.asrConfidence), 0) / segments.length;
    const durationScore = Math.min(1, durationUs / 8_000_000);
    ranked.push({
      startUs: exact.startUs,
      endUs: exact.endUs,
      referenceText: exact.text,
      ...(resolvedSpeaker ? { speakerId: resolvedSpeaker } : {}),
      segmentIds: segments.map((segment) => segment.id),
      score: candidate.score * 0.55 + averageConfidence * 0.3 + durationScore * 0.15,
    });
  }

  return ranked.sort((a, b) => b.score - a.score)[0];
}
