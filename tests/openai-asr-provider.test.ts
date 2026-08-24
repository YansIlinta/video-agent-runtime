import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAIASRProvider } from "../packages/providers/src/index.js";

const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-openai-asr-")); roots.push(root);
  const target = path.join(root, "speech.wav");
  await writeFile(target, Buffer.from("RIFF0000WAVEfmt "));
  return target;
}

async function mockServer(body: unknown): Promise<string> {
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume multipart upload */ }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address"); return `http://127.0.0.1:${address.port}`;
}

describe("OpenAI ASR provider", () => {
  it("normalizes diarized speaker segments with edit-safe timestamps", async () => {
    const baseUrl = await mockServer({ task: "transcribe", duration: 7.2, text: "Hello there. Hi back.", segments: [
      { type: "transcript.text.segment", id: "seg_1", start: 0, end: 3.1, text: "Hello there.", speaker: "A" },
      { type: "transcript.text.segment", id: "seg_2", start: 3.2, end: 7.2, text: "Hi back.", speaker: "B" },
    ] });
    const provider = new OpenAIASRProvider("gpt-4o-transcribe-diarize", "test-key", baseUrl);
    const result = await provider.transcribe(await fixture(), { prompt: "ignored for diarize" });
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ startSeconds: 0, endSeconds: 3.1, speaker: "A", text: "Hello there." });
    expect(result.warnings[0]).toMatch(/prompt is not supported/);
    expect(provider.capabilities()).toMatchObject({ segmentTimestamps: true, speakerDiarization: true, wordTimestamps: false });
  });

  it("normalizes whisper segment and word timestamps", async () => {
    const baseUrl = await mockServer({ language: "english", duration: 2, text: "hello world", segments: [{ id: 0, start: 0, end: 2, text: " hello world", avg_logprob: -0.1 }], words: [{ start: 0, end: 0.8, word: "hello" }, { start: 0.9, end: 1.8, word: "world" }] });
    const provider = new OpenAIASRProvider("whisper-1", "test-key", baseUrl);
    const result = await provider.transcribe(await fixture());
    expect(result.language).toBe("english");
    expect(result.segments[0]?.words.map((word) => word.text)).toEqual(["hello", "world"]);
    expect(provider.capabilities()).toMatchObject({ segmentTimestamps: true, wordTimestamps: true, speakerDiarization: false });
  });

  it("fails before opening or uploading media when already cancelled", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled first"));
    const provider = new OpenAIASRProvider("whisper-1", "test-key", "https://example.invalid/v1");
    await expect(provider.transcribe("missing.wav", {}, { signal: controller.signal })).rejects.toThrow(/cancelled first/);
  });
});
