import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ProjectStore, secondsToUs } from "../packages/core/src/index.js";
import { FFmpegVisualEvidenceProvider, probeMedia, runProcess } from "../packages/media/src/index.js";
import { FakeASRProvider, FakeLLMProvider, FakeTTSProvider } from "../packages/providers/src/index.js";
import { FFmpegRenderer, selfCheckPreview } from "../packages/render/src/index.js";
import { VideoAgentCore } from "../packages/runtime/src/index.js";

const demoRoot = path.resolve("work/e2e-demo");
const projectsRoot = path.join(demoRoot, "projects");
const sourcePath = path.join(demoRoot, "interview.mp4");

await rm(demoRoot, { recursive: true, force: true });
await mkdir(demoRoot, { recursive: true });
const generated = await runProcess(process.env.FFMPEG_PATH ?? "ffmpeg", [
  "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=8",
  "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=8",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", sourcePath,
], { timeoutMs: 120_000 });
if (generated.exitCode !== 0) throw new Error(generated.stderr);

const core = new VideoAgentCore(new ProjectStore(projectsRoot), {
  asr: new FakeASRProvider(),
  tts: new FakeTTSProvider(),
  planner: new FakeLLMProvider(),
  renderer: new FFmpegRenderer(),
  previewSelfCheck: selfCheckPreview,
  mediaProbe: { probe: (uri) => probeMedia(uri) },
  visual: new FFmpegVisualEvidenceProvider(),
});

const { project } = await core.createProject("E2E interview");
const asset = await core.importVideo(project.id, sourcePath);
const asrStarted = performance.now();
await core.transcribe(project.id, asset.id, {
  language: "en",
  prompt: "AI products fail when teams only optimize models. Reliable workflows turn strong models into useful products.",
});
const asrLatencyMs = performance.now() - asrStarted;
const visualEvidence = await core.inspectVisualRange(project.id, 0, secondsToUs(2));
const strategy = await core.proposeStrategy(project.id, "Create a concise hook-first short with minimal captions", secondsToUs(6));
await core.approveStrategy(project.id, strategy.id);
const plan = await core.createEditPlan(project.id);
const validation = await core.validatePlan(project.id, plan.id);
if (!validation.valid) throw new Error(JSON.stringify(validation.issues));
await core.applyPlan(project.id, plan.id);
const previewStarted = performance.now();
const previewV1 = await core.renderPreview(project.id);
const previewLatencyMs = performance.now() - previewStarted;
await core.submitFeedback(project.id, "1~2 seconds are too slow");
const diagnosis = await core.diagnose(project.id);
const patch = await core.createPatch(project.id);
const patchValidation = await core.validatePatch(project.id, patch.id);
if (!patchValidation.valid) throw new Error(JSON.stringify(patchValidation.issues));
const patchDiff = await core.diffPatch(project.id, patch.id);
await core.applyPatch(project.id, patch.id);
const previewV2 = await core.renderPreview(project.id);
await core.addNarration(project.id, { text: "Why do AI workflows fail?", voiceId: "narrator-1", language: "en", timelineInUs: 0, targetDurationUs: secondsToUs(3), actionOnOverflow: "extend" });
const previewV3 = await core.renderPreview(project.id);
await core.approveFinal(project.id);
const finalStarted = performance.now();
const final = await core.exportVideo(project.id);
const finalLatencyMs = performance.now() - finalStarted;
const previewSizeBytes = (await import("node:fs/promises")).stat(previewV1.outputPath).then((value) => value.size);

process.stdout.write(`${JSON.stringify({ projectId: project.id, visualEvidence, validation, previewV1, diagnosis, patchValidation, patchDiff, previewV2, previewV3, final, metrics: { asrLatencyMs: Math.round(asrLatencyMs), previewLatencyMs: Math.round(previewLatencyMs), finalLatencyMs: Math.round(finalLatencyMs), previewSizeBytes: await previewSizeBytes }, versions: (await core.listVersions(project.id)).map((version) => ({ version: version.version, reason: version.operation.reason, diff: version.diff })) }, null, 2)}\n`);
