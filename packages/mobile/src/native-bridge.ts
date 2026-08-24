import type { Asset } from "../../core/src/schemas.js";
import type { BackgroundTaskRequest, FileStat, HttpRequest, LogicalUri, PermissionKind, ResourceBudget } from "../../platform/src/contracts.js";
import type { RendererCapabilities } from "../../providers/src/contracts.js";

export type MobilePlatform = "ios" | "android";

export interface ImportedMobileAsset {
  sourceUri: string;
  displayName: string;
  mediaType?: string;
  sizeBytes?: number;
}

export interface NativeRenderSpec {
  jobId: string;
  projectId: string;
  mode: "preview" | "final";
  outputUri: LogicalUri;
  /** Exact encoder output geometry, already derived from the timeline and the render mode. */
  outputWidth: number;
  outputHeight: number;
  /** Already restricted to the requested range and rebased to zero. Natives render it as given. */
  timelineJson: string;
  assetsJson: string;
}

export interface NativeRenderResult {
  outputUri: LogicalUri;
  durationUs: number;
  warnings: string[];
}

/** Coarse-grained TurboModule boundary. Binary-heavy media never crosses JS. */
export interface NativeVideoHostBridge {
  platform(): Promise<MobilePlatform>;
  read(uri: LogicalUri): Promise<number[]>;
  write(uri: LogicalUri, bytes: number[], atomic: boolean, createOnly: boolean): Promise<void>;
  remove(uri: LogicalUri, recursive: boolean): Promise<void>;
  exists(uri: LogicalUri): Promise<boolean>;
  stat(uri: LogicalUri): Promise<FileStat>;
  list(uri: LogicalUri): Promise<LogicalUri[]>;
  copy(source: string, destination: LogicalUri): Promise<void>;
  diskFreeBytes(): Promise<number>;

  pickVideo(): Promise<ImportedMobileAsset | undefined>;
  probe(uri: LogicalUri): Promise<Asset["metadata"]>;
  render(spec: NativeRenderSpec): Promise<NativeRenderResult>;
  cancelRender(jobId: string): Promise<void>;
  rendererCapabilities(): Promise<RendererCapabilities>;

  secureSet(key: string, value: string): Promise<void>;
  secureGet(key: string): Promise<string | undefined>;
  secureDelete(key: string): Promise<void>;

  /**
   * Bodies cross as base64. They previously crossed as UTF-8 text in and an integer array out,
   * which silently corrupted any non-text payload and made a real audio upload impossible.
   */
  http(request: Omit<HttpRequest, "body" | "signal"> & { bodyBase64?: string }): Promise<{ status: number; headers: Record<string, string>; bodyBase64: string }>;
  scheduleBackground(task: BackgroundTaskRequest): Promise<void>;
  cancelBackground(id: string): Promise<void>;
  pendingBackground(): Promise<BackgroundTaskRequest[]>;
  backgroundBudgetMs(): Promise<number | undefined>;
  permissionStatus(kind: PermissionKind): Promise<"unknown" | "granted" | "denied" | "limited">;
  requestPermission(kind: PermissionKind): Promise<"granted" | "denied" | "limited">;
  resourceBudget(): Promise<ResourceBudget>;
  sha256(data: number[] | string): Promise<string>;
  sha256File(uri: LogicalUri): Promise<string>;
  randomBytes(length: number): number[];
  createId(): string;
}

export type NativeProgressEvent = { jobId: string; progress: number; phase: string; message?: string };
