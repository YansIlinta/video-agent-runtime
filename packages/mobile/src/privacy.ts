import { contextPackSchema, remoteContextPolicySchema, type ContextPack, type EditingStrategy, type Feedback, type ProviderConfig, type RemoteContextPolicy, type Timeline, type Transcript } from "../../core/src/schemas.js";
import type { RuntimePrimitives } from "../../platform/src/contracts.js";

export interface ContextPackInput { projectId: string; provider: ProviderConfig; policy?: Partial<RemoteContextPolicy>; approvedAt?: string; transcript?: Transcript; strategy?: EditingStrategy; timeline?: Timeline; feedback?: Feedback[] }
/**
 * Only the modes this host actually implements. `text-and-derived-visuals` and `allow-remote-media`
 * were offered while the policy was forced to text-only regardless, so choosing them did nothing.
 * Frame extraction is reported as unavailable by the capability matrix, and ContextPack sources
 * cannot express media, so neither mode can be honoured yet.
 */
export const MOBILE_PRIVACY_MODES = [
  { id: "local-only", label: "Local Only" },
  { id: "text-only", label: "Text Only" },
] as const;
export async function buildMobileContextPack(primitives: RuntimePrimitives, input: ContextPackInput): Promise<{ pack: ContextPack; payload: Record<string, unknown>; evidence: { textBytes: number; frames: number; remoteMediaBytes: number; categories: string[] } }> {
  // Reject what this host cannot honour instead of quietly rewriting the caller's policy.
  const policy = remoteContextPolicySchema.parse({ mode: "text-only", ...input.policy });
  if (policy.mode === "local-only") throw new Error("Remote provider calls are disabled by Local Only policy");
  if (policy.mode !== "text-only") throw new Error(`Privacy mode ${policy.mode} is not implemented on this host; it sends text only`);
  if (policy.includeRawMedia) throw new Error("This host cannot include raw media in a ContextPack");
  if (policy.requireApproval && !input.approvedAt) throw new Error("ContextPack requires explicit approval before remote transmission");
  const payload: Record<string, unknown> = {}; const sources: ContextPack["sources"] = []; const categories: string[] = [];
  const add = async (type: ContextPack["sources"][number]["type"], id: string, value: unknown) => { const text = JSON.stringify(value); payload[type] = value; sources.push({ type, id, sha256: await primitives.crypto.sha256(text) }); categories.push(type); };
  if (policy.includeTranscript && input.transcript) await add("transcript", input.transcript.id, { language: input.transcript.language, segments: input.transcript.segments.map((item) => ({ id: item.id, startUs: item.startUs, endUs: item.endUs, text: item.normalizedText })) });
  if (input.strategy) await add("strategy", input.strategy.id, input.strategy);
  if (input.timeline) await add("timeline", input.timeline.id, { durationUs: input.timeline.durationUs, tracks: input.timeline.tracks.map((track) => ({ id: track.id, type: track.type, clips: track.clips.map((clip) => ({ id: clip.id, sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs, timelineInUs: clip.timelineInUs, timelineOutUs: clip.timelineOutUs })) })) });
  if (input.feedback?.length) await add("feedback", input.feedback.at(-1)!.id, input.feedback.map((item) => ({ id: item.id, message: item.message, range: item.range })));
  const textBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength; const pack = contextPackSchema.parse({ schemaVersion: 1, id: primitives.ids.create(), projectId: input.projectId, providerConfigId: input.provider.id, policy, sources, transformations: ["removed local URIs", "excluded raw media"], fields: categories, estimatedBytes: textBytes, approvedAt: input.approvedAt ?? primitives.clock.now().toISOString(), createdAt: primitives.clock.now().toISOString() });
  // Derived from what was actually packed, not asserted as constants. ContextPack sources are
  // text categories only, so a non-zero count here means something new started crossing the wire.
  const visualCategories = new Set(["frame", "keyframe", "thumbnail", "ocr"]);
  const frames = sources.filter((source) => visualCategories.has(source.type)).length;
  const remoteMediaBytes = Object.entries(payload).reduce((sum, [type, value]) => sum + (visualCategories.has(type) ? new TextEncoder().encode(JSON.stringify(value)).byteLength : 0), 0);
  return { pack, payload, evidence: { textBytes, frames, remoteMediaBytes, categories } };
}
