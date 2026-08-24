import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { secondsToUs, type EditPatch, type EditPlan, type EditingStrategy, type Timeline, type Transcript, type VoiceDesignRequest } from "../../core/src/index.js";
import type { ASRProvider, ASRResult, LLMProvider, Renderer, RenderRequest, TTSProvider, TTSResult, VoiceEnrollmentInput, VoiceProvider } from "./contracts.js";

function wavWithTone(durationSeconds: number, sampleRate = 24_000): Uint8Array {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    const envelope = Math.min(1, i / 800, (sampleCount - i) / 800);
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 1_200 * envelope);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}

export class FakeASRProvider implements ASRProvider {
  readonly id = "fake-asr";
  readonly model = "deterministic-v1";

  capabilities() {
    return { wordTimestamps: true, segmentTimestamps: true, speakerDiarization: true, languageDetection: true, streaming: false, confidence: true, forcedAlignment: true };
  }

  async transcribe(_inputPath: string, options?: { language?: string; prompt?: string }): Promise<ASRResult> {
    const text = options?.prompt?.trim() || "AI products fail when teams focus on models instead of building a reliable workflow. A strong workflow makes every model more useful.";
    const tokens = text.split(/\s+/u).filter(Boolean);
    const wordDuration = 0.45;
    const words = tokens.map((token, index) => ({ text: token, startSeconds: index * wordDuration, endSeconds: (index + 1) * wordDuration - 0.05, confidence: 0.98, speaker: "speaker-1" }));
    const segments: ASRResult["segments"] = [];
    for (let index = 0; index < words.length; index += 10) {
      const group = words.slice(index, index + 10);
      if (!group[0] || !group.at(-1)) continue;
      segments.push({ text: group.map((word) => word.text).join(" "), startSeconds: group[0].startSeconds, endSeconds: group.at(-1)!.endSeconds, confidence: 0.98, speaker: "speaker-1", language: options?.language ?? "en", words: group });
    }
    return { language: options?.language ?? "en", languageConfidence: 0.99, segments, warnings: ["FakeASRProvider output; do not use as real transcription evidence"] };
  }
}

export class FakeTTSProvider implements TTSProvider {
  readonly id: string = "fake-tts";
  readonly model: string = "tone-v1";

  capabilities() {
    return { streaming: false, voiceSelection: true, voiceCloning: false, styleControl: false, speedControl: true, multilingual: true, timestamps: true, phonemeAlignment: false };
  }

  async listVoices() {
    return [{ id: "narrator-1", type: "preset" as const, provider: this.id, providerVoiceId: "narrator-1", model: this.model, name: "Test narrator", languages: ["en", "zh"], cloning: false, status: "active" as const, referenceAssetIds: [], authorizationStatus: "not_required" as const, createdAt: new Date(0).toISOString(), usageRestrictions: ["Synthetic test tone; not natural speech"], providerMetadata: {}, license: { code: "project-MIT", weights: "none", voice: "synthetic-tone", commercialUse: true, sourceUrl: "https://example.invalid/fake-tts" } }];
  }

  async synthesize(input: { text: string; voiceId: string; language: string; speed?: number }): Promise<TTSResult> {
    const tokens = input.text.trim().split(/\s+/u).filter(Boolean);
    const speed = input.speed ?? 1;
    const durationSeconds = Math.max(0.4, (tokens.length * 0.38) / speed);
    const wordDuration = durationSeconds / Math.max(1, tokens.length);
    return {
      audio: wavWithTone(durationSeconds),
      format: "wav",
      durationSeconds,
      sampleRate: 24_000,
      wordTimings: tokens.map((text, index) => ({ text, startSeconds: index * wordDuration, endSeconds: (index + 1) * wordDuration })),
      model: this.model,
      voiceId: input.voiceId,
      license: { code: "project-MIT", weights: "none", voice: "synthetic-tone", commercialUse: true, sourceUrl: "https://example.invalid/fake-tts" },
    };
  }
}

export class FakeVoiceProvider extends FakeTTSProvider implements VoiceProvider {
  readonly id = "fake-voice";
  readonly model = "deterministic-voice-v1";
  voiceCapabilities() { return { tts: true, presetVoices: true, voiceDesign: true, zeroShotClone: true, persistentVoiceProfile: true, crossLingualClone: true, voiceConversion: false, streaming: false, wordTimestamps: true, emotionControl: true, styleControl: true, remoteDeletion: true }; }
  override capabilities() { return { streaming: false, voiceSelection: true, voiceCloning: true, styleControl: true, speedControl: true, multilingual: true, timestamps: true, phonemeAlignment: false }; }
  async enrollVoice(input: VoiceEnrollmentInput) { return { providerVoiceId: `fake-clone-${input.referenceAssetId}`, model: this.model, providerMetadata: { enrollment: "deterministic-test" }, derivedRepresentation: new TextEncoder().encode(`fake-derived:${input.referenceAssetId}`) }; }
  async designVoice(input: VoiceDesignRequest) { return { providerVoiceId: `fake-design-${Buffer.from(input.description).toString("hex").slice(0, 12)}`, model: this.model, sample: await this.synthesize({ text: input.sampleText, voiceId: "designed", language: input.language }), providerMetadata: { description: input.description } }; }
  async deleteVoice(_providerVoiceId: string) {}
}

export class FakeLLMProvider implements LLMProvider {
  readonly id = "fake-llm";
  readonly model = "deterministic-v1";

  capabilities() { return { structuredOutput: true, cancellation: false, tokenUsage: false, repair: false }; }

  async proposeStrategy(input: { projectId: string; prompt: string; transcript: Transcript; targetDurationUs: number }): Promise<EditingStrategy> {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      goal: input.prompt,
      structure: "hook-first",
      targetDurationUs: input.targetDurationUs,
      pace: "fast",
      tone: "informative, natural, not over-marketed",
      selectionPolicy: "high-information-density",
      preserveOriginalMeaning: true,
      preserveOriginalWording: true,
      captionStyle: "minimal",
      brollPolicy: "none",
      rationale: ["Open with the most information-dense statement", "Remove repetition and dead air", "Keep original wording and use minimal captions"],
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
  }

  async createEditPlan(input: { projectId: string; strategy: EditingStrategy; transcript: Transcript; assetId: string; basedOnVersion: number }): Promise<EditPlan> {
    const candidates = [...input.transcript.segments].sort((a, b) => {
      const aDensity = a.displayText.length / Math.max(1, a.endUs - a.startUs);
      const bDensity = b.displayText.length / Math.max(1, b.endUs - b.startUs);
      return bDensity - aDensity;
    });
    const selected: typeof candidates = [];
    let durationUs = 0;
    for (const segment of candidates) {
      const segmentDuration = segment.endUs - segment.startUs;
      if (selected.length > 0 && durationUs + segmentDuration > input.strategy.targetDurationUs) continue;
      selected.push(segment);
      durationUs += segmentDuration;
      if (durationUs >= input.strategy.targetDurationUs * 0.85) break;
    }
    if (selected.length === 0 && input.transcript.segments[0]) selected.push(input.transcript.segments[0]);
    let timelineInUs = 0;
    const segments = selected.map((segment, index) => {
      const result = { id: randomUUID(), assetId: input.assetId, sourceInUs: segment.startUs, sourceOutUs: segment.endUs, timelineInUs, speed: 1, reason: index === 0 ? "strong hook" : "high information density", transcriptSegmentIds: [segment.id] };
      timelineInUs += segment.endUs - segment.startUs;
      return result;
    });
    return {
      schemaVersion: 1,
      id: randomUUID(),
      projectId: input.projectId,
      goal: input.strategy.goal,
      strategyId: input.strategy.id,
      segments,
      captions: { enabled: input.strategy.captionStyle !== "none", style: input.strategy.captionStyle === "none" ? "minimal" : input.strategy.captionStyle },
      audio: { normalize: true, originalAudio: "keep", originalGainDb: 0, ducking: { enabled: false, targetGainDb: -12 } },
      reason: "Deterministic fake planner output for offline testing",
      basedOnVersion: input.basedOnVersion,
      feedbackIds: [],
      createdAt: new Date().toISOString(),
    };
  }

  async createEditPatch(input: { projectId: string; plan: EditPlan; timeline: Timeline; transcript: Transcript; feedback: Array<{ id: string; message: string; range?: { startUs: number; endUs: number } }>; basedOnVersion: number }): Promise<EditPatch> {
    const latest = input.feedback.at(-1);
    if (!latest?.range) throw new Error("Fake Patch Planner requires range-scoped feedback");
    const videoTrack = input.timeline.tracks.find((track) => track.type === "video");
    const affected = videoTrack?.clips.filter((clip) => clip.timelineOutUs > latest.range!.startUs && clip.timelineInUs < latest.range!.endUs) ?? [];
    if (affected.length === 0) throw new Error("Feedback range does not overlap a video segment");
    const target = affected[0]!;
    const sourceDuration = target.sourceOutUs - target.sourceInUs;
    const trimBy = Math.min(Math.round(sourceDuration * 0.2), secondsToUs(0.75));
    return { schemaVersion: 1, id: randomUUID(), projectId: input.projectId, basedOnVersion: input.basedOnVersion, feedbackIds: [latest.id], scope: { timelineRanges: [latest.range], segmentIds: affected.map((clip) => clip.id), trackIds: [videoTrack!.id] }, reason: `Minimal deterministic patch for: ${latest.message}`, operations: [{ type: "trimSegment", segmentId: target.id, sourceOutUs: Math.max(target.sourceInUs + 100_000, target.sourceOutUs - trimBy), reason: "Tighten the first affected segment without changing unrelated content" }], createdAt: new Date().toISOString() };
  }
}

export class FakeRenderer implements Renderer {
  readonly id = "fake-renderer";
  renderPreview(request: Omit<RenderRequest, "mode">) { return this.render({ ...request, mode: "preview" }); }
  renderFinal(request: Omit<RenderRequest, "mode">) { return this.render({ ...request, mode: "final" }); }
  private async render(request: RenderRequest) {
    await mkdir(path.dirname(request.outputPath), { recursive: true });
    await writeFile(request.outputPath, JSON.stringify({ timelineId: request.timeline.id, mode: request.mode }));
    return { outputPath: request.outputPath, durationUs: request.range ? request.range.endUs - request.range.startUs : request.timeline.durationUs, mode: request.mode, warnings: ["FakeRenderer artifact is not a playable video"] };
  }
}

export function fitTtsToRange(durationSeconds: number, targetSeconds: number, maxSpeed = 1.2): { fits: boolean; requiresRewrite: boolean; requiresTimelineExtension: boolean; failed: boolean; suggestedSpeed: number } {
  if (durationSeconds <= targetSeconds) return { fits: true, requiresRewrite: false, requiresTimelineExtension: false, failed: false, suggestedSpeed: 1 };
  const requiredSpeed = durationSeconds / targetSeconds;
  if (requiredSpeed <= maxSpeed) return { fits: true, requiresRewrite: false, requiresTimelineExtension: false, failed: false, suggestedSpeed: Math.round(requiredSpeed * 100) / 100 };
  return { fits: false, requiresRewrite: true, requiresTimelineExtension: true, failed: false, suggestedSpeed: maxSpeed };
}

export const DEFAULT_TARGET_DURATION_US = secondsToUs(60);
