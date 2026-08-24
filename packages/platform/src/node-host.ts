import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FetchHttpAdapter, MemoryBackgroundExecution, SystemClock } from "./portable.js";
import type { CryptoAdapter, FileSystemAdapter, HostProfile, LogicalUri, SecureStorageAdapter } from "./contracts.js";

function contained(root: string, candidate: string) { const resolvedRoot = path.resolve(root); const resolved = path.resolve(candidate); const relative = path.relative(resolvedRoot, resolved); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Logical URI escapes host root: ${candidate}`); return resolved; }
export class NodeLogicalFileSystem implements FileSystemAdapter {
  constructor(private readonly root: string) {}
  private resolve(uri: LogicalUri) { const match = uri.match(/^(?:project|cache|export|memory):\/\/(.+)$/u); if (!match?.[1]) throw new Error(`Node host cannot resolve ${uri}`); return contained(this.root, match[1]); }
  async read(uri: LogicalUri) { return new Uint8Array(await readFile(this.resolve(uri))); }
  async write(uri: LogicalUri, data: Uint8Array, options?: { atomic?: boolean; createOnly?: boolean }) { const target = this.resolve(uri); await mkdir(path.dirname(target), { recursive: true }); if (options?.atomic) { const temp = `${target}.${randomUUID()}.tmp`; await writeFile(temp, data, { flag: options.createOnly ? "wx" : "w" }); await rm(target, { force: true }); await import("node:fs/promises").then((fs) => fs.rename(temp, target)); } else await writeFile(target, data, { flag: options?.createOnly ? "wx" : "w" }); }
  async delete(uri: LogicalUri, options?: { recursive?: boolean }) { await rm(this.resolve(uri), { force: true, recursive: options?.recursive ?? false }); }
  async exists(uri: LogicalUri) { try { await access(this.resolve(uri)); return true; } catch { return false; } }
  async stat(uri: LogicalUri) { const value = await stat(this.resolve(uri)); return { sizeBytes: value.size, kind: value.isDirectory() ? "directory" as const : "file" as const, modifiedAt: value.mtime.toISOString() }; }
  async list(uri: LogicalUri) { const root = this.resolve(uri); return (await readdir(root)).map((name) => `${uri.replace(/\/$/u, "")}/${name}` as LogicalUri); }
  async copy(source: LogicalUri, destination: LogicalUri) { const target = this.resolve(destination); await mkdir(path.dirname(target), { recursive: true }); await copyFile(this.resolve(source), target); }
}
export class NodeCryptoAdapter implements CryptoAdapter { async sha256(data: Uint8Array | string) { return createHash("sha256").update(data).digest("hex"); } randomBytes(length: number) { return new Uint8Array(randomBytes(length)); } }
export class NodeIdAdapter { create() { return randomUUID(); } }
export class EnvironmentSecureStorage implements SecureStorageAdapter {
  private readonly overrides = new Map<string, string>();
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  private envName(key: string) { return key.startsWith("env://") ? key.slice(6) : undefined; }
  async set(key: string, value: string) { this.overrides.set(key, value); }
  async get(key: string) { const name = this.envName(key); return this.overrides.get(key) ?? (name ? this.env[name] : undefined); }
  async delete(key: string) { this.overrides.delete(key); }
  async has(key: string) { return (await this.get(key)) !== undefined; }
}
export function createNodeHostProfile(root: string): HostProfile {
  return { id: "node-local", primitives: { ids: new NodeIdAdapter(), clock: new SystemClock(), crypto: new NodeCryptoAdapter() }, filesystem: new NodeLogicalFileSystem(root), secureStorage: new EnvironmentSecureStorage(), http: new FetchHttpAdapter(), background: new MemoryBackgroundExecution(), capabilities: { host: "node-local", media: { probe: true, previewRender: true, finalRender: true, frameExtraction: true, waveform: true, backgroundExport: true, hardwareDecode: false, hardwareEncode: false }, localAsr: true, localTts: true, alignment: true, diarization: true, voiceClone: true, backgroundExecution: true, resourceBudget: { maxWorkingSetBytes: 8 * 1024 ** 3, maxConcurrentMediaJobs: 2, previewMaxWidth: 1920, previewMaxDurationUs: 600_000_000, thermalState: "unknown", powerState: "external" } } };
}
