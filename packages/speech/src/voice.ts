import { createHash, randomUUID } from "node:crypto";
import type { DurationFitDecision, ProjectRepository, VoiceProfile, VoiceReferenceQualityReport } from "../../core/src/index.js";

const ANALYSIS_VERSION = "voice-reference-v1";

export async function analyzeVoiceReference(store: ProjectRepository, projectId: string, assetId: string, speakerId?: string): Promise<VoiceReferenceQualityReport> {
  const project = await store.readProject(projectId);
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset) throw new Error(`Unknown asset ${assetId}`);
  const cacheKey = createHash("sha256").update(JSON.stringify({ sha256: asset.sha256, speakerId, version: ANALYSIS_VERSION })).digest("hex");
  const cached = await store.findVoiceReferenceQualityByCacheKey(projectId, cacheKey);
  if (cached) return cached;
  const transcript = project.activeTranscriptId ? await store.readTranscript(projectId, project.activeTranscriptId) : undefined;
  const segments = transcript?.segments.filter((segment) => !speakerId || segment.speakerId === speakerId) ?? [];
  const candidates = segments
    .filter((segment) => segment.endUs - segment.startUs >= 2_000_000)
    .map((segment) => ({ startUs: segment.startUs, endUs: Math.min(segment.endUs, segment.startUs + 15_000_000), score: Math.min(1, (segment.confidence ?? 0.8) * (segment.endUs - segment.startUs >= 8_000_000 ? 1 : 0.85)), reasons: ["single transcript segment", "high ASR confidence", "bounded to 15 seconds"] }))
    .sort((a, b) => b.score - a.score).slice(0, 5);
  const speechDurationUs = segments.reduce((sum, segment) => sum + segment.endUs - segment.startUs, 0) || asset.metadata.durationUs;
  const speakerCount = transcript?.speakers.length ?? 0;
  const averageConfidence = segments.length ? segments.reduce((sum, segment) => sum + (segment.confidence ?? 0.75), 0) / segments.length : 0.5;
  const report: VoiceReferenceQualityReport = {
    id: randomUUID(), projectId, assetId, assetSha256: asset.sha256, analysisVersion: ANALYSIS_VERSION, speechDurationUs,
    snrDb: 30, clippingRatio: 0, musicProbability: transcript?.quality.musicHeavyRanges.length ? 0.6 : 0.05, reverbScore: 0.1,
    speakerCount, silenceRatio: Math.max(0, Math.min(1, 1 - speechDurationUs / Math.max(1, asset.metadata.durationUs))), speakerConsistency: speakerId ? 0.95 : speakerCount <= 1 ? 0.9 : 0.6,
    asrConfidence: averageConfidence, usableSpeechPercentage: Math.min(100, (speechDurationUs / Math.max(1, asset.metadata.durationUs)) * 100), candidates,
    warnings: ["SNR, clipping, music and reverb are conservative metadata/transcript estimates until an optional acoustic analyzer is configured"], cacheKey, createdAt: new Date().toISOString(),
  };
  await store.writeVoiceReferenceQuality(projectId, report);
  return report;
}

export function assertVoiceAuthorized(profile: VoiceProfile): void {
  if (profile.status !== "active") throw new Error(`VoiceProfile ${profile.id} is not active`);
  if (profile.type === "cloned" && profile.authorizationStatus !== "authorized") throw new Error("Unauthorized voice enrollment or use rejected");
  if (profile.authorizationStatus === "revoked" || profile.authorizationStatus === "denied") throw new Error("Voice authorization is not valid");
}

export function fitSpeechToRange(generatedDurationUs: number, targetDurationUs: number, options: { maxRate?: number; allowRewrite?: boolean; allowExtend?: boolean; allowReplan?: boolean } = {}): DurationFitDecision {
  const maxRate = options.maxRate ?? 1.2;
  const requiredRate = generatedDurationUs / Math.max(1, targetDurationUs);
  if (requiredRate <= 1.02) return { action: "ACCEPT", requiredRate, allowedRate: 1, targetDurationUs, generatedDurationUs, reason: "Generated speech fits the requested range" };
  if (requiredRate <= maxRate) return { action: "ADJUST_RATE", requiredRate, allowedRate: Math.round(requiredRate * 100) / 100, targetDurationUs, generatedDurationUs, reason: "A bounded rate adjustment fits without exceeding the configured intelligibility limit" };
  if (options.allowRewrite) return { action: "REWRITE_SHORTER", requiredRate, allowedRate: maxRate, targetDurationUs, generatedDurationUs, reason: "Text must be shortened with entity and number preservation" };
  if (options.allowExtend) return { action: "EXTEND_TIMELINE", requiredRate, allowedRate: maxRate, targetDurationUs, generatedDurationUs, reason: "Explicit timeline extension is allowed" };
  if (options.allowReplan) return { action: "REPLAN_SURROUNDING_EDIT", requiredRate, allowedRate: maxRate, targetDurationUs, generatedDurationUs, reason: "Surrounding edits may be replanned explicitly" };
  return { action: "ASK_USER", requiredRate, allowedRate: maxRate, targetDurationUs, generatedDurationUs, reason: "No safe automatic fit action is authorized" };
}

export function voiceGenerationCacheKey(input: { text: string; profile: VoiceProfile; provider: string; model: string; language: string; speed?: number; style?: Record<string, unknown> }): string {
  return createHash("sha256").update(JSON.stringify({ text: input.text.normalize("NFKC").trim(), voiceProfileId: input.profile.id, authorizationStatus: input.profile.authorizationStatus, provider: input.provider, model: input.model, language: input.language, speed: input.speed ?? 1, style: input.style ?? {} })).digest("hex");
}
