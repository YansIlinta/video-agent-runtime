import { formatTimecode, rangesOverlap } from "./time.js";
import type { Transcript } from "./schemas.js";

export function transcriptToTimelineMarkdown(transcript: Transcript): string {
  const wordById = new Map(transcript.words.map((word) => [word.id, word]));
  const blocks = transcript.segments.map((segment) => {
    const words = segment.wordIds.map((id) => wordById.get(id)).filter((word) => word !== undefined);
    const confidenceValues = words.map((word) => word.confidence).filter((value): value is number => value !== undefined);
    const confidence = confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : segment.confidence;
    const warnings = transcript.quality.longSilenceRanges.filter((range) => rangesOverlap(segment.startUs, segment.endUs, range.startUs, range.endUs)).map(() => "long-silence");
    return [
      `[${formatTimecode(segment.startUs)} - ${formatTimecode(segment.endUs)}]`,
      "",
      `SPEAKER: ${segment.speakerId ?? "unknown"}`,
      "",
      `TEXT: ${segment.displayText}`,
      "",
      "VISUAL: not inspected",
      "",
      "SCREEN_TEXT: not inspected",
      "",
      "AUDIO: speech",
      "",
      `CONFIDENCE: ${confidence === undefined ? "unknown" : confidence.toFixed(3)}`,
      ...(warnings.length ? ["", `WARNINGS: ${warnings.join(", ")}`] : []),
    ].join("\n");
  });
  return `# Timeline context\n\nAsset: ${transcript.assetId}\nProvider: ${transcript.provider}/${transcript.model}\nLanguage: ${transcript.language ?? "unknown"}\n\n${blocks.join("\n\n---\n\n")}\n`;
}
