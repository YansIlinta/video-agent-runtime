import { z } from "zod";

export const schemaVersion = 1 as const;

export const idSchema = z.string().min(1).max(200);
export const timeUsSchema = z.number().int().nonnegative().safe();
export const timestampSchema = z.string().datetime();

export const rationalSchema = z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() });

export const logicalUriSchema = z.string().regex(/^(project|import|cache|export|memory):\/\/.+/u);
export const assetRefSchema = z.object({
  uri: logicalUriSchema,
  storageClass: z.enum(["durable", "imported", "cache", "export"]),
  mediaType: z.string().optional(),
  displayName: z.string().optional(),
});

export const mediaMetadataSchema = z.object({
  durationUs: timeUsSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: rationalSchema.optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  formatName: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
});

export const assetSchema = z.object({
  id: idSchema,
  kind: z.enum(["source_video", "source_audio", "derived_audio", "tts", "image", "other"]),
  originalName: z.string().min(1),
  relativePath: z.string().min(1),
  ref: assetRefSchema.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: mediaMetadataSchema,
  createdAt: timestampSchema,
  provenance: z.object({ provider: z.string().optional(), model: z.string().optional(), sourceAssetIds: z.array(idSchema).default([]) }).optional(),
});

export const wordTimestampSchema = z.object({
  id: idSchema,
  rawText: z.string(),
  normalizedText: z.string(),
  displayText: z.string(),
  startUs: timeUsSchema,
  endUs: timeUsSchema,
  confidence: z.number().min(0).max(1).optional(),
  speakerId: idSchema.optional(),
  timingSource: z.enum(["asr", "aligned", "estimated"]).default("asr"),
}).superRefine((word, ctx) => {
  if (word.endUs <= word.startUs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "word endUs must be greater than startUs" });
});

export const transcriptSegmentSchema = z.object({
  id: idSchema,
  startUs: timeUsSchema,
  endUs: timeUsSchema,
  speakerId: idSchema.optional(),
  language: z.string().min(2).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rawText: z.string(),
  normalizedText: z.string(),
  displayText: z.string(),
  wordIds: z.array(idSchema),
}).superRefine((segment, ctx) => {
  if (segment.endUs <= segment.startUs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "segment endUs must be greater than startUs" });
});

export const transcriptQualityReportSchema = z.object({
  lowConfidenceWordIds: z.array(idSchema).default([]),
  unmappedWordIds: z.array(idSchema).default([]),
  failedAlignmentSegmentIds: z.array(idSchema).default([]),
  speakerOverlapRanges: z.array(z.object({ startUs: timeUsSchema, endUs: timeUsSchema })).default([]),
  unknownLanguageSegmentIds: z.array(idSchema).default([]),
  musicHeavyRanges: z.array(z.object({ startUs: timeUsSchema, endUs: timeUsSchema })).default([]),
  longSilenceRanges: z.array(z.object({ startUs: timeUsSchema, endUs: timeUsSchema })).default([]),
  warnings: z.array(z.string()).default([]),
});

export const transcriptSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  assetId: idSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  language: z.string().optional(),
  languageConfidence: z.number().min(0).max(1).optional(),
  rawTranscript: z.string(),
  normalizedTranscript: z.string(),
  displayTranscript: z.string(),
  words: z.array(wordTimestampSchema),
  segments: z.array(transcriptSegmentSchema),
  speakers: z.array(z.object({ id: idSchema, label: z.string().optional() })).default([]),
  silenceRegions: z.array(z.object({ startUs: timeUsSchema, endUs: timeUsSchema, confidence: z.number().min(0).max(1).optional() })).default([]),
  quality: transcriptQualityReportSchema,
  cacheKey: z.string().min(1),
  provenance: z.object({ rawResultPath: z.string().optional(), alignmentProvider: z.string().optional(), diarizationProvider: z.string().optional() }).optional(),
  createdAt: timestampSchema,
});

export const alignmentResultSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  words: z.array(z.object({ rawText: z.string(), startUs: timeUsSchema, endUs: timeUsSchema, confidence: z.number().min(0).max(1).optional() })),
  failedSegmentIds: z.array(idSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export const speakerSegmentSchema = z.object({ speakerId: idSchema, startUs: timeUsSchema, endUs: timeUsSchema, confidence: z.number().min(0).max(1).optional() }).superRefine((segment, ctx) => {
  if (segment.endUs <= segment.startUs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "speaker segment range must be positive" });
});

export const diarizationResultSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), segments: z.array(speakerSegmentSchema), warnings: z.array(z.string()).default([]) });

export const visualEvidenceSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  projectId: idSchema,
  assetId: idSchema,
  range: z.object({ startUs: timeUsSchema, endUs: timeUsSchema }),
  shots: z.array(z.object({ id: idSchema, startUs: timeUsSchema, endUs: timeUsSchema, confidence: z.number().min(0).max(1).optional() })).default([]),
  keyframes: z.array(z.object({ id: idSchema, timeUs: timeUsSchema, relativePath: z.string().min(1) })).default([]),
  ocr: z.array(z.object({ text: z.string(), startUs: timeUsSchema, endUs: timeUsSchema, confidence: z.number().min(0).max(1).optional() })).default([]),
  faceObservations: z.array(z.object({ timeUs: timeUsSchema, faceCount: z.number().int().nonnegative(), speakerVisible: z.boolean().optional() })).default([]),
  summary: z.string(),
  provider: z.string(),
  createdAt: timestampSchema,
});

export const editingStrategySchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  goal: z.string().min(1),
  structure: z.enum(["hook-first", "chronological-summary", "problem-solution", "argument-led", "custom"]),
  targetDurationUs: timeUsSchema,
  pace: z.enum(["slow", "moderate", "fast"]),
  tone: z.string().min(1),
  selectionPolicy: z.string().min(1),
  preserveOriginalMeaning: z.boolean(),
  preserveOriginalWording: z.boolean(),
  captionStyle: z.enum(["none", "minimal", "bold", "natural"]),
  brollPolicy: z.enum(["none", "minimal", "allowed"]),
  rationale: z.array(z.string()).min(1),
  status: z.enum(["proposed", "approved", "superseded"]),
  createdAt: timestampSchema,
});

export const editSegmentSchema = z.object({
  id: idSchema,
  assetId: idSchema,
  sourceInUs: timeUsSchema,
  sourceOutUs: timeUsSchema,
  timelineInUs: timeUsSchema,
  speed: z.number().min(0.5).max(2).default(1),
  reason: z.string().min(1),
  transcriptSegmentIds: z.array(idSchema).default([]),
}).superRefine((segment, ctx) => {
  if (segment.sourceOutUs <= segment.sourceInUs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sourceOutUs must be greater than sourceInUs" });
});

export const audioPolicySchema = z.object({
  normalize: z.boolean().default(true),
  originalAudio: z.enum(["keep", "lower", "mute"]).default("keep"),
  originalGainDb: z.number().min(-60).max(12).default(0),
  ducking: z.object({ enabled: z.boolean(), targetGainDb: z.number().min(-60).max(0) }).default({ enabled: false, targetGainDb: -12 }),
});

export const captionPolicySchema = z.object({ enabled: z.boolean(), style: z.enum(["minimal", "bold", "natural"]).default("minimal") });

export const editPlanSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  projectId: idSchema,
  goal: z.string().min(1),
  strategyId: idSchema,
  segments: z.array(editSegmentSchema).min(1),
  captions: captionPolicySchema,
  audio: audioPolicySchema,
  reason: z.string().min(1),
  basedOnVersion: z.number().int().nonnegative(),
  feedbackIds: z.array(idSchema).default([]),
  createdAt: timestampSchema,
});

export const timelineRangeSchema = z.object({ startUs: timeUsSchema, endUs: timeUsSchema }).superRefine((range, ctx) => {
  if (range.endUs <= range.startUs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "range endUs must be greater than startUs" });
});

const patchBaseSchema = z.object({ reason: z.string().min(1) });
export const editPatchOperationSchema = z.discriminatedUnion("type", [
  patchBaseSchema.extend({ type: z.literal("removeSegment"), segmentId: idSchema }),
  patchBaseSchema.extend({ type: z.literal("trimSegment"), segmentId: idSchema, sourceInUs: timeUsSchema.optional(), sourceOutUs: timeUsSchema.optional() }),
  patchBaseSchema.extend({ type: z.literal("moveSegment"), segmentId: idSchema, timelineInUs: timeUsSchema }),
  patchBaseSchema.extend({ type: z.literal("replaceSegment"), segmentId: idSchema, segment: editSegmentSchema }),
  patchBaseSchema.extend({ type: z.literal("insertSegment"), segment: editSegmentSchema }),
  patchBaseSchema.extend({ type: z.literal("updateCaption"), clipId: idSchema, text: z.string() }),
  patchBaseSchema.extend({ type: z.literal("updateAudio"), trackId: idSchema, gainDb: z.number().min(-60).max(12).optional(), muted: z.boolean().optional(), ducking: z.object({ enabled: z.boolean(), targetGainDb: z.number().min(-60).max(0) }).optional() }),
  patchBaseSchema.extend({ type: z.literal("updateNarration"), clipId: idSchema, timelineInUs: timeUsSchema.optional(), gainDb: z.number().min(-60).max(12).optional() }),
  patchBaseSchema.extend({ type: z.literal("updateTransition"), clipId: idSchema, transition: z.string().min(1) }),
  patchBaseSchema.extend({ type: z.literal("updateStrategyField"), field: z.enum(["structure", "pace", "tone", "selectionPolicy", "captionStyle", "brollPolicy"]), value: z.unknown() }),
  patchBaseSchema.extend({ type: z.literal("insertAudioClip"), trackId: idSchema, clip: z.lazy(() => clipSchema) }),
  patchBaseSchema.extend({ type: z.literal("insertCaptionClip"), trackId: idSchema, clip: z.lazy(() => clipSchema) }),
  patchBaseSchema.extend({ type: z.literal("replaceAudioClip"), trackId: idSchema, clipId: idSchema, clip: z.lazy(() => clipSchema) }),
  patchBaseSchema.extend({ type: z.literal("replaceCaptionText"), clipId: idSchema, text: z.string().min(1), speechAssetId: idSchema.optional() }),
]);

export const editPatchSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  projectId: idSchema,
  basedOnVersion: z.number().int().nonnegative(),
  feedbackIds: z.array(idSchema).min(1),
  scope: z.object({ timelineRanges: z.array(timelineRangeSchema).min(1), segmentIds: z.array(idSchema), trackIds: z.array(idSchema) }),
  reason: z.string().min(1),
  operations: z.array(editPatchOperationSchema).min(1),
  globalChangeJustification: z.string().min(1).optional(),
  createdAt: timestampSchema,
});

export const clipSchema = z.object({
  id: idSchema,
  type: z.enum(["video", "audio", "caption", "overlay"]),
  assetId: idSchema.optional(),
  sourceInUs: timeUsSchema,
  sourceOutUs: timeUsSchema,
  timelineInUs: timeUsSchema,
  timelineOutUs: timeUsSchema,
  speed: z.number().positive().default(1),
  gainDb: z.number().min(-60).max(12).optional(),
  text: z.string().optional(),
  transcriptWordIds: z.array(idSchema).default([]),
  metadata: z.record(z.unknown()).default({}),
}).superRefine((clip, ctx) => {
  if (clip.sourceOutUs <= clip.sourceInUs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "clip source range must be positive" });
  if (clip.timelineOutUs <= clip.timelineInUs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "clip timeline range must be positive" });
});

export const trackSchema = z.object({
  id: idSchema,
  type: z.enum(["video", "original_audio", "narration", "tts_replacement", "dubbing", "music", "sfx", "caption", "overlay"]),
  name: z.string().min(1),
  muted: z.boolean().default(false),
  gainDb: z.number().min(-60).max(12).default(0),
  ducking: z.object({ enabled: z.boolean(), targetGainDb: z.number().min(-60).max(0) }).optional(),
  clips: z.array(clipSchema),
});

export const timelineSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  projectId: idSchema,
  frameRate: rationalSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationUs: timeUsSchema,
  tracks: z.array(trackSchema),
  strategyId: idSchema.optional(),
  editPlanId: idSchema.optional(),
  updatedAt: timestampSchema,
});

export const feedbackCategorySchema = z.enum(["pace", "hook", "story_structure", "segment_selection", "ordering", "length", "caption", "visual", "audio", "tts", "narration", "broll", "transition", "specific_cut", "other"]);

export const feedbackSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  version: z.number().int().nonnegative(),
  category: feedbackCategorySchema,
  rawMessage: z.string().min(1),
  message: z.string().min(1),
  range: z.object({ startUs: timeUsSchema, endUs: timeUsSchema }).optional(),
  severity: z.enum(["low", "medium", "high"]),
  createdAt: timestampSchema,
});

export const diagnosisSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  feedbackIds: z.array(idSchema).min(1),
  rootCause: feedbackCategorySchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).min(1),
  recommendedAction: z.enum(["PATCH", "REPLAN", "ASK_USER", "KEEP_CURRENT"]),
  strategyChanges: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown(), reason: z.string() })).default([]),
  createdAt: timestampSchema,
});

export const workflowStateSchema = z.enum(["CREATED", "INGESTING", "TRANSCRIBING", "ANALYZING", "READY", "PROPOSING", "WAITING_PROPOSAL_APPROVAL", "PLANNING", "VALIDATING", "APPLYING", "RENDERING_PREVIEW", "EVALUATING_PREVIEW", "WAITING_REVIEW", "PROCESSING_FEEDBACK", "DIAGNOSING", "PATCHING", "REPLANNING", "WAITING_FINAL_APPROVAL", "EXPORTING", "DONE", "FAILED"]);

export const workflowStepSchema = z.object({
  id: idSchema,
  from: workflowStateSchema,
  to: workflowStateSchema,
  status: z.enum(["running", "completed", "failed"]),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  retryCount: z.number().int().nonnegative(),
  startedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
});

export const workflowRunSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  projectId: idSchema,
  state: workflowStateSchema,
  steps: z.array(workflowStepSchema),
  updatedAt: timestampSchema,
});

export const jobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const failureClassSchema = z.enum(["transient", "permanent", "invalid_input", "resource_exhausted", "cancelled", "provider_error"]);
export const jobSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  type: z.enum(["asr", "alignment", "diarization", "visual-analysis", "preview-render", "final-render", "tts", "voice-reference-analysis", "voice-enroll", "voice-design", "voice-preview", "dubbing", "align-generated-speech", "llm-strategy", "llm-edit-plan", "llm-patch-plan"]),
  projectId: idSchema,
  status: jobStatusSchema,
  progress: z.number().min(0).max(1),
  phase: z.string(),
  message: z.string().optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  idempotencyKey: z.string().min(1).optional(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  retryHistory: z.array(z.object({ attempt: z.number().int().positive(), failureClass: failureClassSchema, error: z.string(), at: timestampSchema, retryAt: timestampSchema.optional() })).default([]),
  error: z.string().optional(),
  failureClass: failureClassSchema.optional(),
  cancellationRequested: z.boolean().default(false),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  updatedAt: timestampSchema,
});

export const jobEventSchema = z.object({ id: idSchema, jobId: idSchema, projectId: idSchema, type: z.enum(["job.queued", "job.started", "job.progress", "job.retrying", "job.completed", "job.failed", "job.cancelled"]), phase: z.string(), progress: z.number().min(0).max(1), message: z.string().optional(), createdAt: timestampSchema });

export const providerCallSchema = z.object({
  id: idSchema,
  projectId: idSchema.optional(),
  operation: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  requestId: z.string().optional(),
  latencyMs: z.number().int().nonnegative(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() }).optional(),
  retryCount: z.number().int().nonnegative(),
  validation: z.object({ valid: z.boolean(), issues: z.array(z.string()) }),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  inputDurationUs: timeUsSchema.optional(),
  outputDurationUs: timeUsSchema.optional(),
  cacheHit: z.boolean().optional(),
  computeMode: z.enum(["cpu", "gpu", "remote", "unknown"]).optional(),
  createdAt: timestampSchema,
});

export const reasoningLevelSchema = z.enum(["off", "low", "medium", "high", "extra-high"]);
export const providerKindSchema = z.enum(["openai", "anthropic", "gemini", "deepseek", "openrouter", "openai-compatible", "custom"]);
export const providerAuthModeSchema = z.enum(["DIRECT_BYOK", "PROVIDER_NATIVE_AUTH", "CUSTOM_RELAY"]);
export const providerConfigSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  kind: providerKindSchema,
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  credentialRef: z.string().min(1).optional(),
  authMode: providerAuthModeSchema,
  reasoning: reasoningLevelSchema.default("off"),
  modelDiscovery: z.enum(["api", "static", "api-with-static-fallback"]).default("api-with-static-fallback"),
  enabled: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({}),
});

export const remoteContextPolicySchema = z.object({
  mode: z.enum(["local-only", "text-only", "text-and-derived-visuals", "allow-remote-media"]),
  includeTranscript: z.boolean().default(true),
  includeOcr: z.boolean().default(false),
  includeRawMedia: z.boolean().default(false),
  includeLocalUris: z.literal(false).default(false),
  requireApproval: z.boolean().default(true),
  redactPatterns: z.array(z.string()).default([]),
});
export const contextPackSchema = z.object({
  schemaVersion: z.literal(schemaVersion), id: idSchema, projectId: idSchema, providerConfigId: idSchema,
  policy: remoteContextPolicySchema, sources: z.array(z.object({ type: z.enum(["transcript", "ocr", "timeline", "feedback", "strategy"]), id: idSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  transformations: z.array(z.string()).default([]), fields: z.array(z.string()), estimatedBytes: z.number().int().nonnegative(), approvedAt: timestampSchema.optional(), createdAt: timestampSchema,
});

export const speechAssetSchema = z.object({
  id: idSchema,
  assetId: idSchema,
  type: z.enum(["tts", "designed_voice", "cloned_voice", "translated_dub"]),
  generated: z.boolean().default(true),
  text: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  voiceId: idSchema,
  voiceProfileId: idSchema.optional(),
  language: z.string().min(2),
  durationUs: timeUsSchema,
  sampleRate: z.number().int().positive(),
  generationParameters: z.record(z.unknown()),
  license: z.object({ code: z.string(), weights: z.string(), voice: z.string(), commercialUse: z.boolean(), sourceUrl: z.string().url() }).optional(),
  wordTimings: z.array(wordTimestampSchema).default([]),
  sourceText: z.string().optional(),
  sourceTextVersion: z.number().int().positive().default(1),
  projectId: idSchema.optional(),
  sourceSegmentIds: z.array(idSchema).default([]),
  cacheKey: z.string().min(1),
  createdAt: timestampSchema,
});

export const voiceProfileSchema = z.object({
  id: idSchema,
  type: z.enum(["preset", "designed", "cloned", "imported"]).default("preset"),
  provider: z.string(),
  providerVoiceId: z.string(),
  name: z.string(),
  model: z.string().default("unknown"),
  languages: z.array(z.string()),
  cloning: z.boolean(),
  status: z.enum(["pending", "preview", "active", "deleted", "failed"]).default("active"),
  referenceAssetIds: z.array(idSchema).default([]),
  authorizationStatus: z.enum(["not_required", "pending", "authorized", "denied", "revoked"]).default("not_required"),
  createdAt: timestampSchema.default(() => new Date().toISOString()),
  source: z.string().optional(),
  consent: z.object({ grantedBy: z.string(), grantedAt: timestampSchema, evidence: z.string(), scope: z.string().default("project"), expiresAt: timestampSchema.optional() }).optional(),
  usageRestrictions: z.array(z.string()).default([]),
  providerMetadata: z.record(z.unknown()).default({}),
  license: z.object({ code: z.string(), weights: z.string(), voice: z.string(), commercialUse: z.boolean(), sourceUrl: z.string().url() }).optional(),
});

export const voiceCapabilitiesSchema = z.object({
  tts: z.boolean(), presetVoices: z.boolean(), voiceDesign: z.boolean(), zeroShotClone: z.boolean(), persistentVoiceProfile: z.boolean(), crossLingualClone: z.boolean(), voiceConversion: z.boolean(), streaming: z.boolean(), wordTimestamps: z.boolean(), emotionControl: z.boolean(), styleControl: z.boolean(), remoteDeletion: z.boolean().default(false),
});

export const voiceReferenceQualityReportSchema = z.object({
  id: idSchema, projectId: idSchema, assetId: idSchema, assetSha256: z.string().regex(/^[a-f0-9]{64}$/), analysisVersion: z.string(), speechDurationUs: timeUsSchema, snrDb: z.number(), clippingRatio: z.number().min(0).max(1), musicProbability: z.number().min(0).max(1), reverbScore: z.number().min(0).max(1), speakerCount: z.number().int().nonnegative(), silenceRatio: z.number().min(0).max(1), speakerConsistency: z.number().min(0).max(1), asrConfidence: z.number().min(0).max(1), usableSpeechPercentage: z.number().min(0).max(100), candidates: z.array(z.object({ startUs: timeUsSchema, endUs: timeUsSchema, score: z.number().min(0).max(1), reasons: z.array(z.string()) })).default([]), warnings: z.array(z.string()).default([]), cacheKey: z.string(), createdAt: timestampSchema,
});

export const voiceDeletionEventSchema = z.object({ id: idSchema, projectId: idSchema, voiceProfileId: idSchema, localReferencesRemoved: z.boolean(), derivedRepresentationsRemoved: z.boolean(), cachesInvalidated: z.boolean(), remoteDeletion: z.enum(["requested", "unsupported", "failed", "not_applicable"]), createdAt: timestampSchema });

export const voiceDesignRequestSchema = z.object({ description: z.string().min(1), language: z.string().min(2), tone: z.string().optional(), pace: z.enum(["slow", "moderate", "fast"]).optional(), agePresentation: z.string().optional(), energy: z.string().optional(), style: z.string().optional(), sampleText: z.string().min(1) });

export const durationFitDecisionSchema = z.object({ action: z.enum(["ACCEPT", "ADJUST_RATE", "REWRITE_SHORTER", "EXTEND_TIMELINE", "REPLAN_SURROUNDING_EDIT", "ASK_USER"]), requiredRate: z.number().positive(), allowedRate: z.number().positive(), targetDurationUs: timeUsSchema, generatedDurationUs: timeUsSchema, reason: z.string() });

export const operationSchema = z.object({
  id: idSchema,
  type: z.enum(["apply_plan", "restore_version", "add_narration", "patch", "speech_replacement", "dubbing"]),
  reason: z.string(),
  editPlanId: idSchema.optional(),
  patchId: idSchema.optional(),
  restoredVersion: z.number().int().positive().optional(),
  feedbackIds: z.array(idSchema).default([]),
  createdAt: timestampSchema,
});

export const editDiffSchema = z.object({
  fromVersion: z.number().int().nonnegative(),
  toVersion: z.number().int().nonnegative(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  moved: z.array(z.string()),
  changed: z.array(z.string()),
  reason: z.string(),
});

export const projectVersionSchema = z.object({
  version: z.number().int().positive(),
  parentVersion: z.number().int().nonnegative(),
  timeline: timelineSchema,
  operation: operationSchema,
  diff: editDiffSchema,
  createdAt: timestampSchema,
});

export const projectSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: idSchema,
  name: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  assets: z.array(assetSchema),
  activeTranscriptId: idSchema.optional(),
  activeStrategyId: idSchema.optional(),
  activeEditPlanId: idSchema.optional(),
  activeVersion: z.number().int().nonnegative(),
  workflowRunId: idSchema,
  finalApprovedVersion: z.number().int().positive().optional(),
});

export type Project = z.infer<typeof projectSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type EditingStrategy = z.infer<typeof editingStrategySchema>;
export type EditPlan = z.infer<typeof editPlanSchema>;
export type EditPatch = z.infer<typeof editPatchSchema>;
export type EditPatchOperation = z.infer<typeof editPatchOperationSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type Diagnosis = z.infer<typeof diagnosisSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type ProjectVersion = z.infer<typeof projectVersionSchema>;
export type EditDiff = z.infer<typeof editDiffSchema>;
export type SpeechAsset = z.infer<typeof speechAssetSchema>;
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;
export type VoiceCapabilities = z.infer<typeof voiceCapabilitiesSchema>;
export type VoiceReferenceQualityReport = z.infer<typeof voiceReferenceQualityReportSchema>;
export type VoiceDeletionEvent = z.infer<typeof voiceDeletionEventSchema>;
export type VoiceDesignRequest = z.infer<typeof voiceDesignRequestSchema>;
export type DurationFitDecision = z.infer<typeof durationFitDecisionSchema>;
export type AlignmentResult = z.infer<typeof alignmentResultSchema>;
export type SpeakerSegment = z.infer<typeof speakerSegmentSchema>;
export type DiarizationResult = z.infer<typeof diarizationResultSchema>;
export type VisualEvidence = z.infer<typeof visualEvidenceSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type FailureClass = z.infer<typeof failureClassSchema>;
export type ProviderCall = z.infer<typeof providerCallSchema>;
export type AssetRef = z.infer<typeof assetRefSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;
export type ProviderAuthMode = z.infer<typeof providerAuthModeSchema>;
export type RemoteContextPolicy = z.infer<typeof remoteContextPolicySchema>;
export type ContextPack = z.infer<typeof contextPackSchema>;
