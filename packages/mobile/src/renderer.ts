import { PortableError, type LogicalUri } from "../../platform/src/contracts.js";
import type { RenderRequest, Renderer, RendererCapabilities } from "../../providers/src/contracts.js";
import type { NativeVideoHostBridge } from "./native-bridge.js";
import { outputSize, sliceTimelineToRange } from "./render-plan.js";

export interface NativeMobileRendererOptions {
  platform: "ios" | "android";
  previewMaxWidth: number;
  createId(): string;
}

export class NativeMobileRenderer implements Renderer {
  readonly id: string;
  private current?: RendererCapabilities;
  constructor(private readonly native: NativeVideoHostBridge, private readonly options: NativeMobileRendererOptions) {
    this.id = options.platform === "ios" ? "ios-native-renderer" : "android-native-renderer";
  }
  /** Conservative until the host has actually reported. Claiming capabilities we have not been told about is how a renderer silently produces wrong output. */
  capabilities(): RendererCapabilities {
    return this.current ?? { trim: true, concat: true, crop: false, scale: false, preserveAudio: true, speed: false, captionBurnIn: false, audioDucking: false, overlay: false, backgroundExport: false };
  }
  async refreshCapabilities() {
    const reported = await this.native.rendererCapabilities();
    // Neither current native renderer implements content-discarding crop. Both only normalize/fill
    // output geometry. Clamp the historical native `crop: true` overclaim at the portable boundary
    // so an EditPlan cannot silently request behavior the renderer does not perform.
    this.current = { ...reported, crop: false };
    return this.current;
  }
  renderPreview(request: Omit<RenderRequest, "mode">) { return this.render({ ...request, mode: "preview" }); }
  renderFinal(request: Omit<RenderRequest, "mode">) { return this.render({ ...request, mode: "final" }); }
  private async render(request: RenderRequest) {
    const capabilities = await this.refreshCapabilities();
    const warnings: string[] = [];
    // Slice before gating so the checks below apply to what will actually be rendered.
    const timeline = request.range ? sliceTimelineToRange(request.timeline, request.range) : request.timeline;
    const videoClips = timeline.tracks.filter((track) => track.type === "video").flatMap((track) => track.clips);
    if (videoClips.length === 0) throw new PortableError("INVALID_INPUT", request.range ? `${this.id} received no video clips inside the requested range` : `${this.id} received a timeline with no video clips`);
    if (!capabilities.concat && videoClips.length > 1) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support concat`);
    if (!capabilities.speed && videoClips.some((clip) => clip.speed !== 1)) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support speed changes`);
    const captions = timeline.tracks.some((track) => track.type === "caption" && track.clips.length > 0);
    // captionBurnIn is tri-state. `!capabilities.captionBurnIn` would let "partial" through silently.
    if (captions && capabilities.captionBurnIn === false) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support caption burn-in`);
    if (captions && capabilities.captionBurnIn === "partial") warnings.push(`${this.id} reports partial caption burn-in; some caption styling may be dropped`);
    if (!capabilities.audioDucking && timeline.tracks.some((track) => track.ducking?.enabled)) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support audio ducking`);
    const size = outputSize(timeline, request.mode, this.options.previewMaxWidth);
    if (size.width !== timeline.width && !capabilities.scale) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} cannot scale a ${timeline.width}px timeline down to a ${size.width}px preview`);
    const assets = [...new Set(timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.assetId ? [clip.assetId] : [])))].map((assetId) => ({ assetId, uri: request.resolveAssetPath(assetId) }));
    const jobId = `render-${request.projectId}-${this.options.createId()}`;
    request.onProgress?.(0.01, "native-queued", "Native render queued");
    const result = await this.native.render({
      jobId, projectId: request.projectId, mode: request.mode, outputUri: request.outputPath as LogicalUri,
      outputWidth: size.width, outputHeight: size.height,
      timelineJson: JSON.stringify(timeline), assetsJson: JSON.stringify(assets),
    });
    request.onProgress?.(1, "native-complete", "Native render complete");
    return { outputPath: result.outputUri, durationUs: result.durationUs, mode: request.mode, warnings: [...warnings, ...result.warnings] };
  }
}
