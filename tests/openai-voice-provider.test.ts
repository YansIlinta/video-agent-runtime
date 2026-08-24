import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIVoiceProvider } from "../packages/providers/src/index.js";

function wav(): Uint8Array { const buffer = Buffer.alloc(44 + 4_800); buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(24_000, 24); buffer.writeUInt32LE(48_000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(4_800, 40); return buffer; }
afterEach(() => vi.restoreAllMocks());

describe("OpenAI voice provider", () => {
  it("requires credentials and explicit hosted consent ids", async () => { const provider = new OpenAIVoiceProvider("gpt-4o-mini-tts", undefined); expect((await provider.health()).status).toBe("unavailable"); await expect(provider.enrollVoice({ name: "mine", referencePath: "unused.wav", referenceAssetId: "asset", languages: ["en"], authorization: { grantedBy: "owner", grantedAt: new Date().toISOString(), evidence: "local consent", scope: "project" } })).rejects.toThrow(/providerAuthorizationId/); });
  it("requests WAV speech without persisting or returning the API key", async () => { const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(wav(), { status: 200, headers: { "content-type": "audio/wav" } })); const provider = new OpenAIVoiceProvider("gpt-4o-mini-tts", "secret-test-key", "https://example.invalid/v1"); const result = await provider.synthesize({ text: "hello", voiceId: "alloy", language: "en" }); expect(result.durationSeconds).toBeCloseTo(0.1); expect(JSON.stringify(result)).not.toContain("secret-test-key"); const init = request.mock.calls[0]![1]!; expect(String(init.body)).not.toContain("secret-test-key"); });
});
