export type HostProfileId = "node-local" | "ios-local" | "android-local" | "mobile-simulation";
export type LogicalUri = `${"project" | "import" | "cache" | "export" | "memory"}://${string}`;

export interface AssetRef {
  uri: LogicalUri;
  storageClass: "durable" | "imported" | "cache" | "export";
  mediaType?: string;
  displayName?: string;
}

export interface RuntimePrimitives {
  ids: IdAdapter;
  clock: ClockAdapter;
  crypto: CryptoAdapter;
}

export interface ClockAdapter { now(): Date; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface IdAdapter { create(): string }
export interface CryptoAdapter { sha256(data: Uint8Array | string): Promise<string>; randomBytes(length: number): Uint8Array }

export interface FileStat { sizeBytes: number; kind: "file" | "directory"; modifiedAt?: string }
export interface FileSystemAdapter {
  read(uri: LogicalUri): Promise<Uint8Array>;
  write(uri: LogicalUri, data: Uint8Array, options?: { atomic?: boolean; createOnly?: boolean }): Promise<void>;
  delete(uri: LogicalUri, options?: { recursive?: boolean }): Promise<void>;
  exists(uri: LogicalUri): Promise<boolean>;
  stat(uri: LogicalUri): Promise<FileStat>;
  list(uri: LogicalUri): Promise<LogicalUri[]>;
  copy(source: LogicalUri, destination: LogicalUri): Promise<void>;
}

export interface SecureStorageAdapter {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stream?: boolean;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  stream?: AsyncIterable<Uint8Array>;
}
export interface HttpAdapter { request(request: HttpRequest): Promise<HttpResponse> }

export interface BackgroundTaskRequest { id: string; kind: string; earliestStartAt?: string; requiresNetwork?: boolean; requiresExternalPower?: boolean }
export interface BackgroundExecutionAdapter {
  schedule(task: BackgroundTaskRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  pending(): Promise<BackgroundTaskRequest[]>;
  executionBudgetMs(): number | undefined;
}

export interface PlatformMediaCapabilities {
  probe: boolean;
  previewRender: boolean;
  finalRender: boolean;
  frameExtraction: boolean;
  waveform: boolean;
  backgroundExport: boolean;
  hardwareDecode: boolean;
  hardwareEncode: boolean;
  maxWidth?: number;
  maxHeight?: number;
}
export interface ResourceBudget {
  maxWorkingSetBytes: number;
  maxConcurrentMediaJobs: number;
  previewMaxWidth: number;
  previewMaxDurationUs: number;
  thermalState: "nominal" | "fair" | "serious" | "critical" | "unknown";
  powerState: "battery" | "charging" | "external" | "unknown";
}
export interface PlatformCapabilities {
  host: HostProfileId;
  media: PlatformMediaCapabilities;
  localAsr: boolean;
  localTts: boolean;
  alignment: boolean;
  diarization: boolean;
  voiceClone: boolean;
  backgroundExecution: boolean;
  resourceBudget: ResourceBudget;
}

export interface HostProfile {
  id: HostProfileId;
  primitives: RuntimePrimitives;
  filesystem: FileSystemAdapter;
  secureStorage: SecureStorageAdapter;
  http: HttpAdapter;
  background: BackgroundExecutionAdapter;
  capabilities: PlatformCapabilities;
}

export type PortableErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "PERMISSION_DENIED" | "AUTH_REQUIRED" | "PROVIDER_AUTH_FAILED" | "NETWORK_UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "RESOURCE_EXHAUSTED" | "INSUFFICIENT_STORAGE" | "UNSUPPORTED_CAPABILITY" | "MEDIA_CODEC_UNSUPPORTED" | "BACKGROUND_INTERRUPTED" | "PROVIDER_ERROR" | "STORAGE_ERROR" | "INTERNAL";
export class PortableError extends Error {
  constructor(readonly code: PortableErrorCode, message: string, readonly retryable = false, readonly details: Record<string, unknown> = {}) { super(message); this.name = "PortableError"; }
}

export type PermissionKind = "photos" | "camera" | "microphone" | "files" | "local-network" | "notifications";
export interface PermissionAdapter { status(kind: PermissionKind): Promise<"unknown" | "granted" | "denied" | "limited">; request(kind: PermissionKind): Promise<"granted" | "denied" | "limited"> }
