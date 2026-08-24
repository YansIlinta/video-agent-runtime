import type { HttpAdapter, HttpRequest, HttpResponse } from "../../platform/src/contracts.js";

export interface MobileNetworkAuditRecord { host: string; requestType: string; method: HttpRequest["method"]; at: string }
export class AuditedMobileHttpAdapter implements HttpAdapter {
  readonly records: MobileNetworkAuditRecord[] = [];
  constructor(private readonly inner: HttpAdapter) {}
  async request(request: HttpRequest): Promise<HttpResponse> { const url = new URL(request.url); this.records.push({ host: url.host, requestType: url.pathname.endsWith("/responses") ? "structured-generation" : url.pathname.endsWith("/models") ? "model-discovery-or-health" : "provider-request", method: request.method, at: new Date().toISOString() }); return this.inner.request(request); }
}
