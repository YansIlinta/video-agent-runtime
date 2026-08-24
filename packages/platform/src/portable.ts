import type { BackgroundExecutionAdapter, BackgroundTaskRequest, ClockAdapter, CryptoAdapter, HttpAdapter, HttpRequest, HttpResponse, IdAdapter, SecureStorageAdapter } from "./contracts.js";

export class SystemClock implements ClockAdapter {
  now(): Date { return new Date(); }
  sleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Cancelled")); }; if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true }); }); }
}
export class WebIdAdapter implements IdAdapter {
  create(): string { return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}
export class WebCryptoAdapter implements CryptoAdapter {
  async sha256(data: Uint8Array | string): Promise<string> { const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data; const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; const digest = await globalThis.crypto.subtle.digest("SHA-256", input); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
  randomBytes(length: number): Uint8Array { const bytes = new Uint8Array(length); globalThis.crypto.getRandomValues(bytes); return bytes; }
}
export class MemorySecureStorage implements SecureStorageAdapter {
  private readonly values = new Map<string, string>();
  async set(key: string, value: string) { this.values.set(key, value); }
  async get(key: string) { return this.values.get(key); }
  async delete(key: string) { this.values.delete(key); }
  async has(key: string) { return this.values.has(key); }
}
export class MemoryBackgroundExecution implements BackgroundExecutionAdapter {
  private readonly tasks = new Map<string, BackgroundTaskRequest>();
  constructor(private readonly budget?: number) {}
  async schedule(task: BackgroundTaskRequest) { this.tasks.set(task.id, task); }
  async cancel(id: string) { this.tasks.delete(id); }
  async pending() { return [...this.tasks.values()]; }
  executionBudgetMs() { return this.budget; }
}
export class FetchHttpAdapter implements HttpAdapter {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error("HTTP request timed out")), request.timeoutMs);
    const abort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abort(); else request.signal?.addEventListener("abort", abort, { once: true });
    try {
      const init: RequestInit = { method: request.method, signal: controller.signal, ...(request.headers ? { headers: request.headers } : {}), ...(request.body === undefined ? {} : { body: request.body as unknown as NonNullable<RequestInit["body"]> }) };
      const response = await fetch(request.url, init);
      const headers: Record<string, string> = {}; response.headers.forEach((value, key) => { headers[key] = value; });
      return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
    } finally { if (timer) clearTimeout(timer); request.signal?.removeEventListener("abort", abort); }
  }
}
