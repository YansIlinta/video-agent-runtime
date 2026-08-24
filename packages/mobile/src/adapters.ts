import { PortableError, type BackgroundExecutionAdapter, type ClockAdapter, type CryptoAdapter, type FileSystemAdapter, type HostProfile, type HttpAdapter, type IdAdapter, type LogicalUri, type PermissionAdapter, type PlatformCapabilities, type SecureStorageAdapter } from "../../platform/src/contracts.js";
import type { NativeVideoHostBridge } from "./native-bridge.js";

function mapped(error: unknown): PortableError {
  if (error instanceof PortableError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /permission|denied/iu.test(message) ? "PERMISSION_DENIED"
    : /space|ENOSPC|quota/iu.test(message) ? "INSUFFICIENT_STORAGE"
      : /codec|format|media.*unsupported/iu.test(message) ? "MEDIA_CODEC_UNSUPPORTED"
        : /background.*(expired|interrupted)/iu.test(message) ? "BACKGROUND_INTERRUPTED"
          : /401|403|auth|credential/iu.test(message) ? "PROVIDER_AUTH_FAILED"
            : /network|offline|connect/iu.test(message) ? "NETWORK_UNAVAILABLE"
              : /timeout/iu.test(message) ? "TIMEOUT"
                : /cancel|abort/iu.test(message) ? "CANCELLED" : "INTERNAL";
  return new PortableError(code, message, ["NETWORK_UNAVAILABLE", "TIMEOUT", "BACKGROUND_INTERRUPTED"].includes(code), { nativeMessage: message });
}

export class NativeFileSystemAdapter implements FileSystemAdapter {
  constructor(private readonly native: NativeVideoHostBridge) {}
  async read(uri: LogicalUri) { try { return Uint8Array.from(await this.native.read(uri)); } catch (error) { throw mapped(error); } }
  async write(uri: LogicalUri, data: Uint8Array, options?: { atomic?: boolean; createOnly?: boolean }) { try { await this.native.write(uri, [...data], options?.atomic ?? false, options?.createOnly ?? false); } catch (error) { throw mapped(error); } }
  async delete(uri: LogicalUri, options?: { recursive?: boolean }) { try { await this.native.remove(uri, options?.recursive ?? false); } catch (error) { throw mapped(error); } }
  async exists(uri: LogicalUri) { return this.native.exists(uri); }
  async stat(uri: LogicalUri) { try { return await this.native.stat(uri); } catch (error) { throw mapped(error); } }
  async list(uri: LogicalUri) { try { return await this.native.list(uri); } catch (error) { throw mapped(error); } }
  async copy(source: LogicalUri, destination: LogicalUri) { try { await this.native.copy(source, destination); } catch (error) { throw mapped(error); } }
}

export class NativeSecureStorageAdapter implements SecureStorageAdapter {
  constructor(private readonly native: NativeVideoHostBridge) {}
  async set(key: string, value: string) { try { await this.native.secureSet(key, value); } catch (error) { throw mapped(error); } }
  async get(key: string) { try { return await this.native.secureGet(key); } catch (error) { throw mapped(error); } }
  async delete(key: string) { try { await this.native.secureDelete(key); } catch (error) { throw mapped(error); } }
  async has(key: string) { return (await this.get(key)) !== undefined; }
}

export class NativeHttpAdapter implements HttpAdapter {
  constructor(private readonly native: NativeVideoHostBridge) {}
  async request(request: Parameters<HttpAdapter["request"]>[0]) {
    if (request.signal?.aborted) throw new PortableError("CANCELLED", "Request cancelled");
    const body = request.body instanceof Uint8Array ? new TextDecoder().decode(request.body) : request.body;
    try { const response = await this.native.http({ method: request.method, url: request.url, ...(request.headers ? { headers: request.headers } : {}), ...(body !== undefined ? { body } : {}), ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}), ...(request.stream !== undefined ? { stream: request.stream } : {}) }); return { ...response, body: Uint8Array.from(response.body) }; }
    catch (error) { throw mapped(error); }
  }
}

export class NativeBackgroundExecutionAdapter implements BackgroundExecutionAdapter {
  constructor(private readonly native: NativeVideoHostBridge) {}
  schedule(task: Parameters<BackgroundExecutionAdapter["schedule"]>[0]) { return this.native.scheduleBackground(task); }
  cancel(id: string) { return this.native.cancelBackground(id); }
  pending() { return this.native.pendingBackground(); }
  executionBudgetMs() { return undefined; }
  async actualExecutionBudgetMs() { return this.native.backgroundBudgetMs(); }
}

export class NativePermissionAdapter implements PermissionAdapter {
  constructor(private readonly native: NativeVideoHostBridge) {}
  status(kind: Parameters<PermissionAdapter["status"]>[0]) { return this.native.permissionStatus(kind); }
  request(kind: Parameters<PermissionAdapter["request"]>[0]) { return this.native.requestPermission(kind); }
}

class MobileClock implements ClockAdapter {
  now() { return new Date(); }
  sleep(ms: number, signal?: AbortSignal) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new PortableError("CANCELLED", "Sleep cancelled")); }, { once: true }); }); }
}

class NativeIds implements IdAdapter { constructor(private readonly native: NativeVideoHostBridge) {} create() { return this.native.createId(); } }

class NativeCrypto implements CryptoAdapter {
  constructor(private readonly native: NativeVideoHostBridge) {}
  sha256(data: Uint8Array | string) { return this.native.sha256(typeof data === "string" ? data : [...data]); }
  randomBytes(length: number) { return Uint8Array.from(this.native.randomBytes(length)); }
}

export async function createNativeHostProfile(native: NativeVideoHostBridge): Promise<{ profile: HostProfile; permissions: PermissionAdapter }> {
  const platform = await native.platform();
  const resourceBudget = await native.resourceBudget();
  const media = await native.rendererCapabilities();
  const capabilities: PlatformCapabilities = {
    host: platform === "ios" ? "ios-local" : "android-local",
    media: { probe: true, previewRender: true, finalRender: true, frameExtraction: false, waveform: false, backgroundExport: media.backgroundExport, hardwareDecode: true, hardwareEncode: true, maxWidth: resourceBudget.previewMaxWidth, maxHeight: 2160 },
    localAsr: false, localTts: false, alignment: false, diarization: false, voiceClone: false,
    backgroundExecution: true,
    resourceBudget,
  };
  return { profile: { id: capabilities.host, primitives: { clock: new MobileClock(), ids: new NativeIds(native), crypto: new NativeCrypto(native) }, filesystem: new NativeFileSystemAdapter(native), secureStorage: new NativeSecureStorageAdapter(native), http: new NativeHttpAdapter(native), background: new NativeBackgroundExecutionAdapter(native), capabilities }, permissions: new NativePermissionAdapter(native) };
}

export { mapped as mapNativeError };
