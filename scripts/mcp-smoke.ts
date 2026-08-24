import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "video-agent-mcp-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/packages/mcp/src/server.js")],
  env: { ...process.env, VIDEO_AGENT_WORKSPACE: workspace } as Record<string, string>,
});
const client = new Client({ name: "video-agent-smoke", version: "0.2.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ["system_status", "job_status", "job_list", "job_cancel", "edit_patch_plan", "edit_patch_apply", "transcript_quality", "visual_inspect_range"]) if (!names.has(required)) throw new Error(`Missing V1.5 tool ${required}`);
  for (const required of ["voice_capabilities", "voice_models", "voice_list", "voice_design", "voice_reference_analyze", "voice_enroll", "voice_preview", "voice_delete", "tts_generate", "tts_preview", "tts_fit_to_range", "speech_replace", "narration_add", "dubbing_generate"]) if (!names.has(required)) throw new Error(`Missing voice tool ${required}`);
  const created = await client.callTool({ name: "project_create", arguments: { name: "MCP smoke" } });
  if (created.isError || !created.structuredContent) throw new Error("project_create did not return structured output");
  const status = await client.callTool({ name: "system_status", arguments: {} });
  if (status.isError || !status.structuredContent) throw new Error("system_status failed");
  process.stdout.write(JSON.stringify({ toolCount: tools.tools.length, projectCreate: "ok", systemStatus: "ok" }, null, 2));
} finally {
  await client.close();
  await rm(workspace, { recursive: true, force: true });
}
