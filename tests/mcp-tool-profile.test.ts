import { describe, expect, it } from "vitest";
import { coreProjectToolNames, projectMcpProfile, shouldExposeProjectTool } from "../packages/mcp/src/tool-profile.js";

describe("project MCP tool profiles", () => {
  it("defaults to the compact core profile", () => {
    expect(projectMcpProfile({})).toBe("core");
    expect(coreProjectToolNames().length).toBeLessThan(40);
    expect(shouldExposeProjectTool("project_create", "core")).toBe(true);
    expect(shouldExposeProjectTool("edit_plan_apply", "core")).toBe(true);
    expect(shouldExposeProjectTool("voice_enroll", "core")).toBe(false);
    expect(shouldExposeProjectTool("visual_inspect_range", "core")).toBe(false);
  });

  it("keeps every registered tool available in full mode", () => {
    expect(projectMcpProfile({ VIDEO_AGENT_MCP_PROFILE: "FULL" })).toBe("full");
    expect(shouldExposeProjectTool("voice_enroll", "full")).toBe(true);
    expect(shouldExposeProjectTool("visual_inspect_range", "full")).toBe(true);
    expect(shouldExposeProjectTool("some_future_tool", "full")).toBe(true);
  });

  it("rejects unknown profiles instead of silently changing the tool surface", () => {
    expect(() => projectMcpProfile({ VIDEO_AGENT_MCP_PROFILE: "minimal-ish" })).toThrow(/core or full/u);
  });
});
