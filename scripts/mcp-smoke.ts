import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function inspectProfile(profile: "core" | "full") {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `video-agent-mcp-${profile}-`));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/packages/mcp/src/server.js")],
    env: { ...process.env, VIDEO_AGENT_WORKSPACE: workspace, VIDEO_AGENT_MCP_PROFILE: profile } as Record<string, string>,
  });
  const client = new Client({ name: `video-agent-smoke-${profile}`, version: "0.4.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const required of ["project_create", "video_import", "asr_transcribe", "strategy_propose", "edit_plan_apply", "preview_render", "feedback_submit", "edit_patch_apply", "final_approve", "export_video", "system_status", "job_cancel"]) {
      if (!names.has(required)) throw new Error(`Missing ${profile} tool ${required}`);
    }
    if (profile === "core") {
      for (const advanced of ["visual_inspect_range", "transcript_quality", "voice_enroll", "dubbing_generate", "version_compare"]) {
        if (names.has(advanced)) throw new Error(`Core profile unexpectedly exposes ${advanced}`);
      }
    } else {
      for (const required of ["visual_inspect_range", "transcript_quality", "voice_capabilities", "voice_enroll", "tts_generate", "speech_replace", "dubbing_generate", "version_compare"]) {
        if (!names.has(required)) throw new Error(`Full profile missing ${required}`);
      }
    }
    const created = await client.callTool({ name: "project_create", arguments: { name: `${profile} MCP smoke` } });
    if (created.isError || !created.structuredContent) throw new Error(`${profile} project_create did not return structured output`);
    const status = await client.callTool({ name: "system_status", arguments: {} });
    if (status.isError || !status.structuredContent) throw new Error(`${profile} system_status failed`);
    return { profile, toolCount: tools.tools.length };
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

const core = await inspectProfile("core");
const full = await inspectProfile("full");
if (core.toolCount >= full.toolCount) throw new Error(`Core profile should expose fewer tools than full (${core.toolCount} >= ${full.toolCount})`);
process.stdout.write(JSON.stringify({ core, full, projectCreate: "ok", systemStatus: "ok" }, null, 2));
