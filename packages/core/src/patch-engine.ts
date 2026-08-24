import { portableId } from "./identity.js";
import { editPatchSchema, type Asset, type EditPatch, type EditPlan, type Project, type Timeline, type Transcript } from "./schemas.js";
import { timelineFromPlan, validateEditPlan, type ValidationIssue } from "./edit-engine.js";
import { rangesOverlap } from "./time.js";

export interface PatchValidationResult { valid: boolean; issues: ValidationIssue[]; affectedClipIds: string[]; unexpectedlyGlobal: boolean }

function operationTarget(operation: EditPatch["operations"][number]): string | undefined {
  if ("segmentId" in operation) return operation.segmentId;
  if ("clipId" in operation) return operation.clipId;
  if ("trackId" in operation) return operation.trackId;
  return undefined;
}

export function validateEditPatch(input: unknown, project: Project, plan: EditPlan, timeline: Timeline, assets: Asset[]): PatchValidationResult {
  const parsed = editPatchSchema.safeParse(input);
  if (!parsed.success) return { valid: false, issues: parsed.error.issues.map((issue) => ({ code: "schema", message: issue.message, path: issue.path.join(".") })), affectedClipIds: [], unexpectedlyGlobal: false };
  const patch = parsed.data;
  const issues: ValidationIssue[] = [];
  if (patch.projectId !== project.id) issues.push({ code: "project_mismatch", message: "EditPatch projectId does not match project" });
  if (patch.basedOnVersion !== project.activeVersion) issues.push({ code: "stale_version", message: `Patch is based on v${patch.basedOnVersion}, active version is v${project.activeVersion}` });
  const allClips = timeline.tracks.flatMap((track) => track.clips);
  const scopedIds = new Set([...patch.scope.segmentIds, ...patch.scope.trackIds]);
  const affectedClipIds = allClips.filter((clip) => patch.scope.timelineRanges.some((range) => rangesOverlap(clip.timelineInUs, clip.timelineOutUs, range.startUs, range.endUs))).map((clip) => clip.id);
  for (const operation of patch.operations) {
    const target = operationTarget(operation);
    if (target && !scopedIds.has(target) && !affectedClipIds.includes(target)) issues.push({ code: "target_outside_scope", message: `${operation.type} targets ${target} outside declared scope` });
    if ("segmentId" in operation && !plan.segments.some((segment) => segment.id === operation.segmentId)) issues.push({ code: "unknown_segment", message: `Unknown segment ${operation.segmentId}` });
    if ("trackId" in operation && !timeline.tracks.some((track) => track.id === operation.trackId) && operation.type !== "insertAudioClip" && operation.type !== "insertCaptionClip") issues.push({ code: "unknown_track", message: `Unknown track ${operation.trackId}` });
    if ("clipId" in operation && !allClips.some((clip) => clip.id === operation.clipId)) issues.push({ code: "unknown_clip", message: `Unknown clip ${operation.clipId}` });
  }
  const requestedDuration = patch.scope.timelineRanges.reduce((sum, range) => sum + range.endUs - range.startUs, 0);
  const unexpectedlyGlobal = timeline.durationUs > 0 && requestedDuration < timeline.durationUs * 0.5 && patch.operations.length > Math.max(3, plan.segments.length / 2);
  if (unexpectedlyGlobal && !patch.globalChangeJustification) issues.push({ code: "unexpected_global_patch", message: "Local feedback produced an unexpectedly global patch without justification" });
  try {
    const simulated = applyPatchToPlan(plan, patch);
    issues.push(...validateEditPlan(simulated, project, assets).issues);
  } catch (error) { issues.push({ code: "patch_semantics", message: error instanceof Error ? error.message : String(error) }); }
  return { valid: issues.length === 0, issues, affectedClipIds, unexpectedlyGlobal };
}

export function applyPatchToPlan(plan: EditPlan, patch: EditPatch): EditPlan {
  let segments = plan.segments.map((segment) => ({ ...segment }));
  for (const operation of patch.operations) {
    switch (operation.type) {
      case "removeSegment": segments = segments.filter((segment) => segment.id !== operation.segmentId); break;
      case "trimSegment": segments = segments.map((segment) => segment.id === operation.segmentId ? { ...segment, ...(operation.sourceInUs === undefined ? {} : { sourceInUs: operation.sourceInUs }), ...(operation.sourceOutUs === undefined ? {} : { sourceOutUs: operation.sourceOutUs }) } : segment); break;
      case "moveSegment": segments = segments.map((segment) => segment.id === operation.segmentId ? { ...segment, timelineInUs: operation.timelineInUs } : segment); break;
      case "replaceSegment": segments = segments.map((segment) => segment.id === operation.segmentId ? operation.segment : segment); break;
      case "insertSegment": segments.push(operation.segment); break;
    }
  }
  if (segments.length === 0) throw new Error("Patch cannot remove every video segment");
  segments.sort((a, b) => a.timelineInUs - b.timelineInUs);
  let timelineInUs = 0;
  segments = segments.map((segment) => { const next = { ...segment, timelineInUs }; timelineInUs += Math.round((segment.sourceOutUs - segment.sourceInUs) / segment.speed); return next; });
  return { ...plan, id: portableId(), segments, basedOnVersion: patch.basedOnVersion, feedbackIds: [...new Set([...plan.feedbackIds, ...patch.feedbackIds])], reason: patch.reason, createdAt: new Date().toISOString() };
}

export function timelineFromPatch(plan: EditPlan, patch: EditPatch, current: Timeline, transcript?: Transcript): { plan: EditPlan; timeline: Timeline } {
  const nextPlan = applyPatchToPlan(plan, patch);
  let timeline = timelineFromPlan(nextPlan, current, transcript);
  for (const operation of patch.operations) {
    if (operation.type === "updateCaption") timeline = { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === operation.clipId ? { ...clip, text: operation.text } : clip) })) };
    if (operation.type === "updateAudio") timeline = { ...timeline, tracks: timeline.tracks.map((track) => track.id === operation.trackId ? { ...track, ...(operation.gainDb === undefined ? {} : { gainDb: operation.gainDb }), ...(operation.muted === undefined ? {} : { muted: operation.muted }), ...(operation.ducking === undefined ? {} : { ducking: operation.ducking }) } : track) };
    if (operation.type === "updateNarration") timeline = { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === operation.clipId ? { ...clip, ...(operation.timelineInUs === undefined ? {} : { timelineInUs: operation.timelineInUs, timelineOutUs: operation.timelineInUs + (clip.timelineOutUs - clip.timelineInUs) }), ...(operation.gainDb === undefined ? {} : { gainDb: operation.gainDb }) } : clip) })) };
    if (operation.type === "updateTransition") timeline = { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === operation.clipId ? { ...clip, metadata: { ...clip.metadata, transition: operation.transition } } : clip) })) };
    if (operation.type === "insertAudioClip") {
      const existing = timeline.tracks.find((track) => track.id === operation.trackId);
      timeline = { ...timeline, tracks: existing ? timeline.tracks.map((track) => track.id === operation.trackId ? { ...track, clips: [...track.clips, operation.clip] } : track) : [...timeline.tracks, { id: operation.trackId, type: operation.trackId.includes("dubbing") ? "dubbing" : "tts_replacement", name: operation.trackId.includes("dubbing") ? "Dubbing" : "Speech replacement", muted: false, gainDb: 0, clips: [operation.clip] }] };
    }
    if (operation.type === "insertCaptionClip") { const existing = timeline.tracks.find((track) => track.id === operation.trackId); timeline = { ...timeline, tracks: existing ? timeline.tracks.map((track) => track.id === operation.trackId ? { ...track, clips: [...track.clips, operation.clip] } : track) : [...timeline.tracks, { id: operation.trackId, type: "caption", name: "Dubbing captions", muted: false, gainDb: 0, clips: [operation.clip] }] }; }
    if (operation.type === "replaceAudioClip") timeline = { ...timeline, tracks: timeline.tracks.map((track) => track.id === operation.trackId ? { ...track, clips: track.clips.map((clip) => clip.id === operation.clipId ? operation.clip : clip) } : track) };
    if (operation.type === "replaceCaptionText") timeline = { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === operation.clipId ? { ...clip, text: operation.text, metadata: { ...clip.metadata, speechAssetId: operation.speechAssetId, source: "generated-speech" } } : clip) })) };
  }
  return { plan: nextPlan, timeline: { ...timeline, durationUs: Math.max(timeline.durationUs, ...timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineOutUs))), updatedAt: new Date().toISOString() } };
}
