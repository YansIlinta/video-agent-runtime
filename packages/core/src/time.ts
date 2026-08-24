export type TimeUs = number;

export const US_PER_SECOND = 1_000_000;

export function secondsToUs(seconds: number): TimeUs {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid seconds: ${seconds}`);
  return Math.round(seconds * US_PER_SECOND);
}

export function usToSeconds(timeUs: TimeUs): number {
  return timeUs / US_PER_SECOND;
}

export function formatTimecode(timeUs: TimeUs): string {
  const totalMs = Math.round(timeUs / 1_000);
  const ms = totalMs % 1_000;
  const totalSeconds = Math.floor(totalMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function rangesOverlap(aStart: TimeUs, aEnd: TimeUs, bStart: TimeUs, bEnd: TimeUs): boolean {
  return aEnd > bStart && aStart < bEnd;
}
