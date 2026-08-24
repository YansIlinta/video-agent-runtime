export type ProjectMcpProfile = "core" | "full";

const CORE_TOOLS = new Set([
  "project_create",
  "project_status",
  "project_open",
  "video_import",
  "video_inspect",
  "asr_transcribe",
  "transcript_read",
  "transcript_search",
  "timeline_read",
  "strategy_propose",
  "strategy_approve",
  "edit_plan_create",
  "edit_plan_validate",
  "edit_plan_diff",
  "edit_plan_apply",
  "preview_render",
  "feedback_submit",
  "workflow_status",
  "workflow_diagnose",
  "workflow_replan",
  "edit_patch_plan",
  "edit_patch_validate",
  "edit_patch_diff",
  "edit_patch_apply",
  "version_list",
  "version_restore",
  "final_approve",
  "export_video",
  "system_status",
  "job_status",
  "job_list",
  "job_cancel",
]);

export function projectMcpProfile(env: NodeJS.ProcessEnv = process.env): ProjectMcpProfile {
  const value = env.VIDEO_AGENT_MCP_PROFILE?.trim().toLowerCase();
  if (!value || value === "core") return "core";
  if (value === "full") return "full";
  throw new Error(`VIDEO_AGENT_MCP_PROFILE must be core or full, got ${value}`);
}

export function shouldExposeProjectTool(name: string, profile: ProjectMcpProfile): boolean {
  return profile === "full" || CORE_TOOLS.has(name);
}

export function coreProjectToolNames(): string[] {
  return [...CORE_TOOLS];
}
