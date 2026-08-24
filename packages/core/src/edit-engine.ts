import { portableId } from "./identity.js";
import { editPlanSchema, type Asset, type EditDiff, type EditPlan, type Project, type Timeline, type Transcript } from "./schemas.js";

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  durationUs: number;
}

function segmentTimelineDuration(segment: EditPlan["segments"][number]): number {
  return Math.round((segment.sourceOutUs - segment.sourceInUs) / segment.speed);
}

export function validateEditPlan(planInput: unknown, project: Project, assets: Asset[]): ValidationResult {
  const parsed = editPlanSchema.safeParse(planInput);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({ code: "schema", message: issue.message, path: issue.path.join(".") })),
      durationUs: 0,
    };
  }
  const plan = parsed.data;
  const issues: ValidationIssue[] = [];
  if (plan.projectId !== project.id) issues.push({ code: "project_mismatch", message: "EditPlan projectId does not match project" });
  if (plan.basedOnVersion !== project.activeVersion) issues.push({ code: "stale_version", message: `Plan is based on v${plan.basedOnVersion}, active version is v${project.activeVersion}` });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const sorted = [...plan.segments].sort((a, b) => a.timelineInUs - b.timelineInUs);
  let previousEnd = 0;
  for (const [index, segment] of sorted.entries()) {
    const asset = assetById.get(segment.assetId);
    if (!asset) issues.push({ code: "unknown_asset", message: `Unknown asset ${segment.assetId}`, path: `segments.${index}.assetId` });
    else if (segment.sourceOutUs > asset.metadata.durationUs) issues.push({ code: "source_out_of_range", message: `Segment exceeds asset duration`, path: `segments.${index}.sourceOutUs` });
    const end = segment.timelineInUs + segmentTimelineDuration(segment);
    if (segment.timelineInUs < previousEnd) issues.push({ code: "timeline_overlap", message: "Video segments overlap", path: `segments.${index}.timelineInUs` });
    previousEnd = Math.max(previousEnd, end);
  }
  return { valid: issues.length === 0, issues, durationUs: previousEnd };
}

export function timelineFromPlan(plan: EditPlan, current: Timeline, transcript?: Transcript): Timeline {
  const videoClips = plan.segments.map((segment) => {
    const durationUs = segmentTimelineDuration(segment);
    return {
      id: segment.id,
      type: "video" as const,
      assetId: segment.assetId,
      sourceInUs: segment.sourceInUs,
      sourceOutUs: segment.sourceOutUs,
      timelineInUs: segment.timelineInUs,
      timelineOutUs: segment.timelineInUs + durationUs,
      speed: segment.speed,
      transcriptWordIds: transcript?.words.filter((word) => word.startUs < segment.sourceOutUs && word.endUs > segment.sourceInUs).map((word) => word.id) ?? [],
      metadata: { reason: segment.reason, transcriptSegmentIds: segment.transcriptSegmentIds },
    };
  });
  const tracks: Timeline["tracks"] = [
    { id: "video-main", type: "video", name: "Video", muted: false, gainDb: 0, clips: videoClips },
    {
      id: "audio-original",
      type: "original_audio",
      name: "Original audio",
      muted: plan.audio.originalAudio === "mute",
      gainDb: plan.audio.originalAudio === "lower" ? plan.audio.originalGainDb : 0,
      ducking: plan.audio.ducking,
      clips: videoClips.map((clip) => ({ ...clip, id: `audio-${clip.id}`, type: "audio" as const, gainDb: plan.audio.originalGainDb })),
    },
  ];
  if (plan.captions.enabled && transcript) {
    const captionClips: Timeline["tracks"][number]["clips"] = [];
    for (const segment of plan.segments) {
      const matchingWords = transcript.words.filter((word) => word.startUs < segment.sourceOutUs && word.endUs > segment.sourceInUs);
      for (const word of matchingWords) {
        const localStart = Math.max(word.startUs, segment.sourceInUs) - segment.sourceInUs;
        const localEnd = Math.min(word.endUs, segment.sourceOutUs) - segment.sourceInUs;
        captionClips.push({
          id: `caption-${segment.id}-${word.id}`,
          type: "caption",
          sourceInUs: word.startUs,
          sourceOutUs: word.endUs,
          timelineInUs: segment.timelineInUs + Math.round(localStart / segment.speed),
          timelineOutUs: segment.timelineInUs + Math.round(localEnd / segment.speed),
          speed: 1,
          text: word.displayText,
          transcriptWordIds: [word.id],
          metadata: { style: plan.captions.style },
        });
      }
    }
    tracks.push({ id: "captions", type: "caption", name: "Captions", muted: false, gainDb: 0, clips: captionClips });
  }
  const durationUs = Math.max(0, ...videoClips.map((clip) => clip.timelineOutUs));
  return {
    ...current,
    durationUs,
    tracks,
    strategyId: plan.strategyId,
    editPlanId: plan.id,
    updatedAt: new Date().toISOString(),
  };
}

function describeClip(clip: Timeline["tracks"][number]["clips"][number]): string {
  return `${clip.id} ${clip.type} @${clip.timelineInUs}-${clip.timelineOutUs}`;
}

export function diffTimelines(before: Timeline, after: Timeline, fromVersion: number, toVersion: number, reason: string): EditDiff {
  const beforeClips = new Map(before.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
  const afterClips = new Map(after.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
  const added = [...afterClips.values()].filter((clip) => !beforeClips.has(clip.id)).map(describeClip);
  const removed = [...beforeClips.values()].filter((clip) => !afterClips.has(clip.id)).map(describeClip);
  const moved: string[] = [];
  const changed: string[] = [];
  for (const [id, next] of afterClips) {
    const previous = beforeClips.get(id);
    if (!previous) continue;
    if (previous.timelineInUs !== next.timelineInUs) moved.push(`${id}: ${previous.timelineInUs} -> ${next.timelineInUs}`);
    if (JSON.stringify(previous) !== JSON.stringify(next) && previous.timelineInUs === next.timelineInUs) changed.push(id);
  }
  return { fromVersion, toVersion, added, removed, moved, changed, reason };
}

export function createOperation(type: "apply_plan" | "restore_version" | "add_narration" | "patch" | "speech_replacement" | "dubbing", reason: string, editPlanId?: string, feedbackIds: string[] = [], patchId?: string, restoredVersion?: number) {
  return { id: portableId(), type, reason, ...(editPlanId ? { editPlanId } : {}), ...(patchId ? { patchId } : {}), ...(restoredVersion ? { restoredVersion } : {}), feedbackIds, createdAt: new Date().toISOString() };
}
