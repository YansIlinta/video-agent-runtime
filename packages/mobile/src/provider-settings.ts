import { providerConfigSchema, type ProviderConfig } from "../../core/src/schemas.js";
import type { FileSystemAdapter, LogicalUri, SecureStorageAdapter } from "../../platform/src/contracts.js";

const SETTINGS_URI = "project://.mobile-settings/providers.json" as LogicalUri;
export class MobileProviderSettings {
  constructor(private readonly files: FileSystemAdapter, private readonly secrets: SecureStorageAdapter) {}
  async list(): Promise<ProviderConfig[]> { if (!await this.files.exists(SETTINGS_URI)) return []; return (JSON.parse(new TextDecoder().decode(await this.files.read(SETTINGS_URI))) as unknown[]).map((item) => providerConfigSchema.parse(item)); }
  async save(config: ProviderConfig, apiKey?: string) { const parsed = providerConfigSchema.parse(config); if (apiKey !== undefined) { if (!parsed.credentialRef) throw new Error("credentialRef is required before storing an API key"); await this.secrets.set(parsed.credentialRef, apiKey); } const values = (await this.list()).filter((item) => item.id !== parsed.id); await this.files.write(SETTINGS_URI, new TextEncoder().encode(`${JSON.stringify([...values, parsed], null, 2)}\n`), { atomic: true }); return parsed; }
  credential(ref: string) { return this.secrets.get(ref); }
  async remove(id: string) { const values = await this.list(); const config = values.find((item) => item.id === id); if (config?.credentialRef) await this.secrets.delete(config.credentialRef); await this.files.write(SETTINGS_URI, new TextEncoder().encode(`${JSON.stringify(values.filter((item) => item.id !== id), null, 2)}\n`), { atomic: true }); }
}
