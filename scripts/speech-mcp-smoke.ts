import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "video-agent-speech-mcp-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/packages/speech-mcp/src/server.js")],
  env: { ...process.env, VIDEO_AGENT_SPEECH_WORKSPACE: workspace } as Record<string, string>,
});
const client = new Client({ name: "video-agent-speech-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  const expected = ["speech_models", "speech_provider_health", "speech_transcribe", "speech_translate", "speech_synthesize", "video_translate"];
  for (const name of expected) if (!names.has(name)) throw new Error(`Missing speech MCP tool ${name}`);
  if (tools.tools.length !== expected.length) throw new Error(`Speech MCP should remain intentionally small: expected ${expected.length} tools, found ${tools.tools.length}`);
  const models = await client.callTool({ name: "speech_models", arguments: {} });
  if (models.isError || !models.structuredContent) throw new Error("speech_models failed");
  process.stdout.write(JSON.stringify({ toolCount: tools.tools.length, speechModels: "ok" }, null, 2));
} finally {
  await client.close();
  await rm(workspace, { recursive: true, force: true });
}
