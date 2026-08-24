import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAILLMProvider } from "../packages/providers/src/index.js";

const servers: http.Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function mockServer(responses: string[]): Promise<string> {
  let index = 0;
  const server = http.createServer((_request, response) => { const text = responses[Math.min(index++, responses.length - 1)]!; response.setHeader("content-type", "application/json"); response.setHeader("x-request-id", `req-${index}`); response.end(JSON.stringify({ id: `resp-${index}`, output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } })); });
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address"); return `http://127.0.0.1:${address.port}`;
}

describe("OpenAI structured provider", () => {
  it("retries malformed JSON and records validation and usage metadata", async () => {
    const baseUrl = await mockServer(["not json", '{"ok":true}']);
    const provider = new OpenAILLMProvider("test-model", "test-key", baseUrl);
    const result = await provider.generateStructured({ requestId: "local-1", operation: "strategy", instructions: "test", input: "test", schemaName: "result", schema: z.object({ ok: z.boolean() }), jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } });
    expect(result.value).toEqual({ ok: true });
    expect(result.metadata).toMatchObject({ retryCount: 1, validation: { valid: true, issues: [] }, usage: { totalTokens: 14 } });
  });

  it("retries schema-invalid JSON", async () => {
    const baseUrl = await mockServer(['{"ok":"yes"}', '{"ok":true}']);
    const provider = new OpenAILLMProvider("test-model", "test-key", baseUrl);
    expect((await provider.generateStructured({ requestId: "local-2", operation: "edit-plan", instructions: "test", input: "test", schemaName: "result", schema: z.object({ ok: z.boolean() }), jsonSchema: { type: "object" } })).metadata.retryCount).toBe(1);
  });
});
