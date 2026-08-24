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
  timelineJson: string;
  assetsJson: string;
  rangeJson?: string;
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

  http(request: Omit<HttpRequest, "body" | "signal"> & { body?: string }): Promise<{ status: number; headers: Record<string, string>; body: number[] }>;
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
