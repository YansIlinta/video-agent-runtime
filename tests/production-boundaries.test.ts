import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../packages/core/src/index.js";
import { runProcess } from "../packages/media/src/index.js";
import { FakeASRProvider, FakeLLMProvider, FakeRenderer, FakeTTSProvider } from "../packages/providers/src/index.js";
import { VideoAgentCore } from "../packages/runtime/src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("production boundaries", () => {
  it("rejects an upload quota before accepting the source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-quota-")); roots.push(root); const store = new ProjectStore(root); const { project } = await store.create("Quota"); const source = path.join(root, "large.bin"); await writeFile(source, Buffer.alloc(32));
    await expect(store.copySourceAsset(project.id, source, 16)).rejects.toThrow(/exceeds/);
  });

  it("reports provider doctor status without exposing secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-doctor-")); roots.push(root); const core = new VideoAgentCore(new ProjectStore(root), { asr: new FakeASRProvider(), tts: new FakeTTSProvider(), planner: new FakeLLMProvider(), renderer: new FakeRenderer() });
    const status = await core.systemStatus(); expect(status.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["fake-llm", "fake-asr", "fake-tts"])); expect(JSON.stringify(status)).not.toMatch(/api[_-]?key/iu);
  });

  it.skipIf(spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0)("terminates FFmpeg through AbortSignal", async () => {
    const controller = new AbortController(); const operation = runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "30", "-f", "null", "-"], { timeoutMs: 60_000, signal: controller.signal }); setTimeout(() => controller.abort(), 100);
    await expect(operation).rejects.toThrow(/cancelled/);
  });
});
