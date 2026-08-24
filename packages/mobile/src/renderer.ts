import { PortableError, type LogicalUri } from "../../platform/src/contracts.js";
import type { RenderRequest, Renderer, RendererCapabilities } from "../../providers/src/contracts.js";
import type { NativeVideoHostBridge } from "./native-bridge.js";

export class NativeMobileRenderer implements Renderer {
  readonly id: string;
  private current?: RendererCapabilities;
  constructor(private readonly native: NativeVideoHostBridge, platform: "ios" | "android") { this.id = platform === "ios" ? "ios-native-renderer" : "android-native-renderer"; }
  capabilities() { return this.current ?? { trim: true, concat: true, crop: true, scale: true, preserveAudio: true, speed: false, captionBurnIn: "partial" as const, audioDucking: false, overlay: false, backgroundExport: false }; }
  async refreshCapabilities() { this.current = await this.native.rendererCapabilities(); return this.current; }
  renderPreview(request: Omit<RenderRequest, "mode">) { return this.render({ ...request, mode: "preview" }); }
  renderFinal(request: Omit<RenderRequest, "mode">) { return this.render({ ...request, mode: "final" }); }
  private async render(request: RenderRequest) {
    const capabilities = await this.refreshCapabilities();
    const videoClips = request.timeline.tracks.filter((track) => track.type === "video").flatMap((track) => track.clips);
    if (!capabilities.concat && videoClips.length > 1) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support concat`);
    if (!capabilities.speed && videoClips.some((clip) => clip.speed !== 1)) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support speed changes`);
    if (!capabilities.captionBurnIn && request.timeline.tracks.some((track) => track.type === "caption" && track.clips.length > 0)) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support caption burn-in`);
    if (!capabilities.audioDucking && request.timeline.tracks.some((track) => track.ducking?.enabled)) throw new PortableError("UNSUPPORTED_CAPABILITY", `${this.id} does not support audio ducking`);
    const assets = [...new Set(request.timeline.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.assetId ? [clip.assetId] : [])))].map((assetId) => ({ assetId, uri: request.resolveAssetPath(assetId) }));
    const jobId = `render-${request.projectId}-${Date.now()}`; request.onProgress?.(0.01, "native-queued", "Native render queued");
    const result = await this.native.render({ jobId, projectId: request.projectId, mode: request.mode, outputUri: request.outputPath as LogicalUri, timelineJson: JSON.stringify(request.timeline), assetsJson: JSON.stringify(assets), ...(request.range ? { rangeJson: JSON.stringify(request.range) } : {}) });
    request.onProgress?.(1, "native-complete", "Native render complete");
    return { outputPath: result.outputUri, durationUs: result.durationUs, mode: request.mode, warnings: result.warnings };
  }
}
