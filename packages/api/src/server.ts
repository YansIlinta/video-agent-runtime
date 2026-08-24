import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { secondsToUs } from "../../core/src/index.js";
import type { VideoAgentCore } from "../../runtime/src/index.js";

async function body(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.byteLength; if (size > maxBytes) throw new Error("Request exceeds configured upload quota"); chunks.push(bytes); } if (!chunks.length) return {}; return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
function send(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }

export function createApiHandler(core: VideoAgentCore, token: string) {
  if (!token) throw new Error("A non-empty API bearer token is required");
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "unauthorized" });
      const url = new URL(request.url ?? "/", "http://localhost"); const parts = url.pathname.split("/").filter(Boolean); const data = await body(request, Math.ceil(core.limits.maxUploadBytes * 4 / 3) + 1_000_000);
      if (request.method === "GET" && url.pathname === "/v1/projects") return send(response, 200, { projectIds: await core.store.listProjectIds() });
      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "projects" && parts[2] && parts.length === 3) return send(response, 200, await core.status(parts[2]));
      const projectId = parts[2]; if (!projectId) return send(response, 404, { error: "not_found" });
      if (request.method === "POST" && parts[3] === "upload") { if (typeof data.sourcePath === "string") return send(response, 202, await core.importVideo(projectId, data.sourcePath)); if (typeof data.fileBase64 !== "string") throw new Error("upload requires sourcePath or fileBase64"); const safeName = path.basename(String(data.filename ?? "upload.mp4")).replace(/[^a-zA-Z0-9._-]+/g, "-"); const temporary = core.store.resolveProjectFile(projectId, `tmp/api-${randomUUID()}-${safeName}`); try { await writeFile(temporary, Buffer.from(data.fileBase64, "base64"), { flag: "wx" }); return send(response, 202, await core.importVideo(projectId, temporary)); } finally { await rm(temporary, { force: true }); } }
      if (request.method === "POST" && parts[3] === "proposal") return send(response, 200, await core.proposeStrategy(projectId, String(data.prompt), secondsToUs(Number(data.targetDurationSeconds))));
      if (request.method === "POST" && parts[3] === "approval") return send(response, 200, await core.approveStrategy(projectId, String(data.strategyId)));
      if (request.method === "POST" && parts[3] === "preview") return send(response, 202, await core.enqueueJob(projectId, "preview-render", {}));
      if (request.method === "POST" && parts[3] === "feedback") return send(response, 200, await core.submitFeedback(projectId, String(data.message)));
      if (request.method === "GET" && parts[3] === "versions" && parts[4] === "compare") return send(response, 200, await core.compareVersions(projectId, Number(url.searchParams.get("from")), Number(url.searchParams.get("to"))));
      if (request.method === "GET" && parts[3] === "voices") return send(response, 200, await core.listVoices(projectId));
      if (request.method === "POST" && parts[3] === "voices" && parts[4] === "design") return send(response, 202, await core.enqueueJob(projectId, "voice-design", data));
      if (request.method === "POST" && parts[3] === "voices" && parts[4] === "enroll") return send(response, 202, await core.enqueueJob(projectId, "voice-enroll", data));
      if (request.method === "POST" && parts[3] === "export") return send(response, 202, await core.enqueueJob(projectId, "final-render", {}));
      if (request.method === "GET" && parts[3] === "jobs") return send(response, 200, parts[4] ? await core.jobStatus(projectId, parts[4]) : await core.listJobs(projectId));
      return send(response, 404, { error: "not_found" });
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  };
}

export function startNetworkApi(core: VideoAgentCore, options: { token: string; host?: string; port?: number }) { const server = createServer(createApiHandler(core, options.token)); server.listen(options.port ?? 8787, options.host ?? "127.0.0.1"); return server; }
