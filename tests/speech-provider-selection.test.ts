import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../packages/runtime/src/config.js";
import { createRuntime } from "../packages/runtime/src/factory.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("speech provider selection", () => {
  it("selects Qwen ASR and voice providers without loading model runtimes during composition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-qwen-selection-")); roots.push(root);
    const config = loadRuntimeConfig({
      VIDEO_AGENT_WORKSPACE: root,
      VIDEO_AGENT_ASR: "qwen3-asr",
      VIDEO_AGENT_ASR_MODEL: "Qwen/Qwen3-ASR-0.6B",
      VIDEO_AGENT_TTS: "qwen3-tts",
      VIDEO_AGENT_TTS_MODEL: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
      VIDEO_AGENT_PYTHON: "definitely-not-invoked-during-composition",
      FFMPEG_PATH: "definitely-not-invoked-during-composition",
    }, root);

    const core = createRuntime({ config });
    expect(core.providers.asr.id).toBe("qwen3-asr");
    expect(core.providers.asr.model).toBe("Qwen/Qwen3-ASR-0.6B");
    expect(core.providers.asr.capabilities()).toMatchObject({ wordTimestamps: true, forcedAlignment: true, speakerDiarization: false });
    expect(core.providers.tts.id).toBe("qwen3-tts");
    expect(core.providers.voice?.cloneReferencePolicy?.()).toEqual({ minDurationSeconds: 3, maxDurationSeconds: 15, highQualityRequiresReferenceText: true, embeddingOnlySupported: true });
  });

  it("keeps fake providers as the zero-dependency default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-default-selection-")); roots.push(root);
    const config = loadRuntimeConfig({ VIDEO_AGENT_WORKSPACE: root }, root);
    const core = createRuntime({ config });
    expect(core.providers.asr.id).toBe("fake-asr");
    expect(core.providers.tts.id).toBe("fake-voice");
  });
});
