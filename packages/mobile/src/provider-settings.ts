import { providerConfigSchema, type ProviderConfig } from "../../core/src/schemas.js";
import type { FileSystemAdapter, LogicalUri, SecureStorageAdapter } from "../../platform/src/contracts.js";

const SETTINGS_URI = "project://.mobile-settings/providers.json" as LogicalUri;
const SLOTS_URI = "project://.mobile-settings/provider-slots.json" as LogicalUri;
export type MobileProviderSlot = "planner" | "asr" | "tts";
type Slots = Partial<Record<MobileProviderSlot, string>>;

export class MobileProviderSettings {
  constructor(private readonly files: FileSystemAdapter, private readonly secrets: SecureStorageAdapter) {}

  async list(): Promise<ProviderConfig[]> {
    if (!await this.files.exists(SETTINGS_URI)) return [];
    return (JSON.parse(new TextDecoder().decode(await this.files.read(SETTINGS_URI))) as unknown[]).map((item) => providerConfigSchema.parse(item));
  }

  private async readSlots(): Promise<Slots> {
    if (!await this.files.exists(SLOTS_URI)) return {};
    const value = JSON.parse(new TextDecoder().decode(await this.files.read(SLOTS_URI))) as Record<string, unknown>;
    const result: Slots = {};
    for (const slot of ["planner", "asr", "tts"] as const) if (typeof value[slot] === "string") result[slot] = value[slot];
    return result;
  }

  private async writeSlots(slots: Slots) {
    await this.files.write(SLOTS_URI, new TextEncoder().encode(`${JSON.stringify(slots, null, 2)}\n`), { atomic: true });
  }

  async save(config: ProviderConfig, apiKey?: string) {
    const parsed = providerConfigSchema.parse(config);
    if (apiKey !== undefined) {
      if (!parsed.credentialRef) throw new Error("credentialRef is required before storing an API key");
      await this.secrets.set(parsed.credentialRef, apiKey);
    }
    const values = (await this.list()).filter((item) => item.id !== parsed.id);
    await this.files.write(SETTINGS_URI, new TextEncoder().encode(`${JSON.stringify([...values, parsed], null, 2)}\n`), { atomic: true });
    return parsed;
  }

  async saveToSlot(slot: MobileProviderSlot, config: ProviderConfig, apiKey?: string) {
    const saved = await this.save(config, apiKey);
    const slots = await this.readSlots(); slots[slot] = saved.id; await this.writeSlots(slots);
    return saved;
  }

  credential(ref: string) { return this.secrets.get(ref); }

  async configForSlot(slot: MobileProviderSlot): Promise<ProviderConfig | undefined> {
    const providerId = (await this.readSlots())[slot];
    if (!providerId) return undefined;
    return (await this.list()).find((item) => item.id === providerId && item.enabled);
  }

  async remove(id: string) {
    const values = await this.list(); const config = values.find((item) => item.id === id); const remaining = values.filter((item) => item.id !== id);
    // A planner/ASR/TTS stack commonly shares one secure credential. Delete the secret only when
    // the last config referencing it is removed.
    if (config?.credentialRef && !remaining.some((item) => item.credentialRef === config.credentialRef)) await this.secrets.delete(config.credentialRef);
    await this.files.write(SETTINGS_URI, new TextEncoder().encode(`${JSON.stringify(remaining, null, 2)}\n`), { atomic: true });
    const slots = await this.readSlots(); let changed = false;
    for (const slot of ["planner", "asr", "tts"] as const) if (slots[slot] === id) { delete slots[slot]; changed = true; }
    if (changed) await this.writeSlots(slots);
  }
}
