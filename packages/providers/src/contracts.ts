import type { AlignmentResult, DiarizationResult, EditingStrategy, EditPatch, EditPlan, ProviderCall, Timeline, Transcript, VisualEvidence, VoiceCapabilities, VoiceDesignRequest, VoiceProfile } from "../../core/src/schemas.js";
import type { ZodType } from "zod";

export interface OperationContext { signal?: AbortSignal; onProgress?: (progress: number, phase: string, message?: string) => void }

export interface ASRCapabilities { wordTimestamps: boolean; segmentTimestamps: boolean; speakerDiarization: boolean; languageDetection: boolean; streaming: boolean; confidence: boolean; forcedAlignment: boolean }
export interface ASRWordResult { text: string; startSeconds: number; endSeconds: number; confidence?: number; speaker?: string }
export interface ASRSegmentResult { text: string; startSeconds: number; endSeconds: number; confidence?: number; speaker?: string; language?: string; words: ASRWordResult[]; alignmentFailed?: boolean }
export interface ASRResult { language?: string; languageConfidence?: number; segments: ASRSegmentResult[]; warnings: string[] }
export interface ASRProvider { readonly id: string; readonly model: string; capabilities(): ASRCapabilities; transcribe(inputPath: string, options?: { language?: string; prompt?: string }, context?: OperationContext): Promise<ASRResult>; health?(): Promise<ProviderHealth> }

export interface AlignmentProvider { readonly id: string; readonly model: string; align(inputPath: string, transcript: Transcript, context?: OperationContext): Promise<AlignmentResult>; health?(): Promise<ProviderHealth> }
export interface DiarizationProvider { readonly id: string; readonly model: string; diarize(inputPath: string, context?: OperationContext): Promise<DiarizationResult>; health?(): Promise<ProviderHealth> }
export interface VisualEvidenceProvider { readonly id: string; inspect(input: { projectId: string; assetId: string; inputPath: string; outputDirectory: string; range: { startUs: number; endUs: number } }, context?: OperationContext): Promise<VisualEvidence>; health?(): Promise<ProviderHealth> }

export interface VoiceReferenceRangeAcousticMetrics {
  startUs: number;
  endUs: number;
  snrDb: number;
  clippingRatio: number;
  silenceRatio: number;
  reverbScore: number;
  rmsDbfs: number;
  peakDbfs: number;
  warnings: string[];
}
export interface VoiceReferenceAcousticAnalyzer {
  readonly id: string;
  analyzeRanges(inputPath: string, ranges: Array<{ startUs: number; endUs: number }>, context?: OperationContext): Promise<VoiceReferenceRangeAcousticMetrics[]>;
  health?(): Promise<ProviderHealth>;
}

export interface TTSCapabilities { streaming: boolean; voiceSelection: boolean; voiceCloning: boolean; styleControl: boolean; speedControl: boolean; multilingual: boolean; timestamps: boolean; phonemeAlignment: boolean }
export interface TTSWordTiming { text: string; startSeconds: number; endSeconds: number }
export interface TTSResult { audio: Uint8Array; format: "wav"; durationSeconds: number; sampleRate: number; wordTimings: TTSWordTiming[]; model: string; voiceId: string; license?: { code: string; weights: string; voice: string; commercialUse: boolean; sourceUrl: string } }
export type TTSFileResult = Omit<TTSResult, "audio">;
export interface TTSInput { text: string; voiceId: string; language: string; speed?: number }
export interface TTSProvider {
  readonly id: string;
  readonly model: string;
  capabilities(): TTSCapabilities;
  listVoices?(): Promise<VoiceProfile[]>;
  synthesize(input: TTSInput, context?: OperationContext): Promise<TTSResult>;
  /** Optional zero-copy path for hosts where binary media should not cross the JS/runtime boundary. */
  synthesizeToFile?: ((input: TTSInput & { outputUri: string }, context?: OperationContext) => Promise<TTSFileResult>) | undefined;
  health?(): Promise<ProviderHealth>;
}

export interface VoiceEnrollmentInput {
  name: string;
  referencePath: string;
  referenceAssetId: string;
  languages: string[];
  /** Exact transcript for referenceRangeSeconds when available. Required by high-quality ICL clone providers. */
  referenceText?: string;
  /** Clean, single-speaker range selected from transcript/quality evidence. */
  referenceRangeSeconds?: { start: number; end: number };
  /** Explicit opt-in to speaker-embedding-only enrollment when the provider supports it. Never implied by a missing transcript. */
  allowEmbeddingOnly?: boolean;
  providerAuthorizationId?: string;
  authorization: { grantedBy: string; grantedAt: string; evidence: string; scope: string };
}
export interface VoiceEnrollmentResult { providerVoiceId: string; model: string; providerMetadata?: Record<string, unknown>; derivedRepresentation?: Uint8Array }
export interface VoiceDesignResult { providerVoiceId: string; model: string; sample: TTSResult; providerMetadata?: Record<string, unknown> }
export interface VoiceCloneReferencePolicy {
  minDurationSeconds: number;
  maxDurationSeconds: number;
  /** True when high-quality cloning requires exact text aligned to the selected reference range. */
  highQualityRequiresReferenceText: boolean;
  /** Whether the provider can deliberately fall back to a speaker embedding without reference text. */
  embeddingOnlySupported: boolean;
}
export interface VoiceProvider extends TTSProvider {
  voiceCapabilities(): VoiceCapabilities;
  cloneReferencePolicy?(): VoiceCloneReferencePolicy;
  enrollVoice?(input: VoiceEnrollmentInput, context?: OperationContext): Promise<VoiceEnrollmentResult>;
  designVoice?(input: VoiceDesignRequest, context?: OperationContext): Promise<VoiceDesignResult>;
  deleteVoice?(providerVoiceId: string, context?: OperationContext): Promise<void>;
}

export interface LLMCapabilities { structuredOutput: boolean; cancellation: boolean; tokenUsage: boolean; repair: boolean }
export interface StructuredGenerationRequest<T> { requestId: string; projectId?: string; operation: "strategy" | "edit-plan" | "patch-plan"; instructions: string; input: string; schemaName: string; schema: ZodType<T>; jsonSchema: Record<string, unknown>; maxRetries?: number; signal?: AbortSignal }
export interface StructuredGenerationResult<T> { value: T; metadata: ProviderCall }
export interface ProviderHealth { id: string; status: "ready" | "unavailable" | "degraded"; message: string; capabilities?: Record<string, unknown> }
export interface LLMProvider {
  readonly id: string;
  readonly model?: string;
  capabilities?(): LLMCapabilities;
  generateStructured?<T>(request: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult<T>>;
  proposeStrategy(input: { projectId: string; prompt: string; transcript: Transcript; targetDurationUs: number }, context?: OperationContext): Promise<EditingStrategy>;
  createEditPlan(input: { projectId: string; strategy: EditingStrategy; transcript: Transcript; assetId: string; basedOnVersion: number }, context?: OperationContext): Promise<EditPlan>;
  createEditPatch?(input: { projectId: string; plan: EditPlan; timeline: Timeline; transcript: Transcript; feedback: Array<{ id: string; message: string; range?: { startUs: number; endUs: number } }>; basedOnVersion: number }, context?: OperationContext): Promise<EditPatch>;
  takeLastCall?(projectId?: string): ProviderCall | undefined;
  cancel?(requestId: string): Promise<void>;
  health?(): Promise<ProviderHealth>;
  evaluateTimeline?(input: { timeline: Timeline; transcript: Transcript }): Promise<{ warnings: string[]; scores: Record<string, number> }>;
}

export interface RenderRequest { projectId: string; timeline: Timeline; outputPath: string; resolveAssetPath(assetId: string): string; mode: "preview" | "final"; range?: { startUs: number; endUs: number }; signal?: AbortSignal; onProgress?: OperationContext["onProgress"] }
export interface RenderResult { outputPath: string; durationUs: number; mode: "preview" | "final"; warnings: string[] }
export interface RendererCapabilities { trim: boolean; concat: boolean; crop: boolean; scale: boolean; preserveAudio: boolean; speed: boolean; captionBurnIn: false | "partial" | true; audioDucking: boolean; overlay: boolean; backgroundExport: boolean }
export interface Renderer { readonly id: string; capabilities?(): RendererCapabilities; renderPreview(request: Omit<RenderRequest, "mode">): Promise<RenderResult>; renderFinal(request: Omit<RenderRequest, "mode">): Promise<RenderResult>; health?(): Promise<ProviderHealth> }
