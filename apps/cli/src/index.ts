#!/usr/bin/env node
import { secondsToUs } from "../../../packages/core/src/index.js";
import { createRuntime } from "../../../packages/runtime/src/index.js";

const args = process.argv.slice(2);
const command = args.shift();
const core = createRuntime();

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return args[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function positional(): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--")) index += 1;
    else if (args[index]) values.push(args[index]!);
  }
  return values;
}
function flag(name: string): boolean { return args.includes(`--${name}`); }
function csvOption(name: string): string[] { return requiredOption(name).split(",").map((value) => value.trim()).filter(Boolean); }

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(): void {
  process.stdout.write(`video-agent — agent-native headless video editing runtime

Commands:
  create <name>
  status --project <id>
  import <video> --project <id>
  transcribe --project <id> --asset <id> [--language zh] [--prompt "context"]
  transcript --project <id> [--search query]
  propose <request> --project <id> [--target 60]
  approve --project <id> --strategy <id>
  plan --project <id>
  validate --project <id> --plan <id>
  diff --project <id> --plan <id>
  apply --project <id> --plan <id>
  preview --project <id> [--start 20 --end 35]
  feedback <message> --project <id> [--category pace] [--start 20 --end 35]
  diagnose --project <id>
  replan --project <id>
  patch --project <id> [--apply] [--preview]
  align --project <id> [--background]
  visual --project <id> --start <s> --end <s> [--background]
  jobs --project <id>
  cancel <job-id> --project <id>
  doctor
  api [--host 127.0.0.1] [--port 8787]
  eval

Voice:
  voice-capabilities
  voices --project <id>
  voice-analyze --project <id> --asset <id> [--speaker <id>]
  voice-enroll --project <id> --asset <id> --name <name> --languages zh,en --authorize --granted-by <who> --evidence <text> [--speaker <id>] [--scope project] [--embedding-only] [--background]
  voice-preview <text> --project <id> --voice-profile <id> [--language zh]
  voice-approve --project <id> --voice-profile <id>
  voice-design <description> --project <id> --sample <text> [--language zh] [--tone <text>] [--pace slow|moderate|fast] [--age <text>] [--energy <text>] [--style <text>]
  voice-delete --project <id> --voice-profile <id>
  narration <text> --project <id> [--at 0] [--voice narrator-1] [--language zh] [--target 3.2 --overflow extend]

Versions / export:
  versions --project <id>
  restore --project <id> --version <n>
  approve-final --project <id>
  export --project <id>

Environment:
  VIDEO_AGENT_CONFIG          Optional JSON configuration file
  VIDEO_AGENT_WORKSPACE       Project workspace root
  VIDEO_AGENT_ASR             fake (default), faster-whisper, qwen3-asr, or openai
  VIDEO_AGENT_ASR_MODEL       ASR model override
  VIDEO_AGENT_TTS             fake, kokoro, qwen3-tts, or openai
  VIDEO_AGENT_TTS_MODEL       TTS / voice model override
  VIDEO_AGENT_PYTHON          Python executable for local speech sidecars
  OPENAI_API_KEY              Enables configured OpenAI planner / ASR / voice providers
  OPENAI_MODEL                OpenAI planner model override
  HF_TOKEN                    Optional WhisperX diarization token
  VIDEO_AGENT_API_TOKEN       Bearer token required by the network API
  FFMPEG_PATH / FFPROBE_PATH  Optional executable overrides

Voice cloning requires explicit authorization. Transcript-backed high-quality enrollment is the default.
--embedding-only is an explicit lower-quality fallback and is never enabled automatically.
`);
}

async function main(): Promise<void> {
  if (!command || command === "help" || command === "--help" || command === "-h") return help();
  switch (command) {
    case "create": return print(await core.createProject(positional().join(" ") || "Untitled Video"));
    case "status": return print(await core.status(requiredOption("project")));
    case "import": return print(await core.importVideo(requiredOption("project"), positional()[0] ?? (() => { throw new Error("Missing video path"); })()));
    case "transcribe": return print(await core.transcribe(requiredOption("project"), requiredOption("asset"), { ...(option("language") ? { language: option("language")! } : {}), ...(option("prompt") ? { prompt: option("prompt")! } : {}) }));
    case "transcript": return print(option("search") ? await core.searchTranscript(requiredOption("project"), option("search")!) : await core.readTranscript(requiredOption("project")));
    case "propose": return print(await core.proposeStrategy(requiredOption("project"), positional().join(" "), secondsToUs(Number(option("target") ?? 60))));
    case "approve": return print(await core.approveStrategy(requiredOption("project"), requiredOption("strategy")));
    case "plan": return print(await core.createEditPlan(requiredOption("project")));
    case "validate": return print(await core.validatePlan(requiredOption("project"), requiredOption("plan")));
    case "diff": return print(await core.diffPlan(requiredOption("project"), requiredOption("plan")));
    case "apply": return print(await core.applyPlan(requiredOption("project"), requiredOption("plan")));
    case "preview": {
      const start = option("start"); const end = option("end");
      return print(await core.renderPreview(requiredOption("project"), start && end ? { startUs: secondsToUs(Number(start)), endUs: secondsToUs(Number(end)) } : undefined));
    }
    case "feedback": {
      const start = option("start"); const end = option("end");
      return print(await core.submitFeedback(requiredOption("project"), positional().join(" "), { ...(option("category") ? { category: option("category") as never } : {}), ...(start && end ? { range: { startUs: secondsToUs(Number(start)), endUs: secondsToUs(Number(end)) } } : {}) }));
    }
    case "diagnose": return print(await core.diagnose(requiredOption("project")));
    case "replan": return print(await core.replan(requiredOption("project")));
    case "patch": {
      const patch = await core.createPatch(requiredOption("project"));
      const validation = await core.validatePatch(requiredOption("project"), patch.id);
      const diff = validation.valid ? await core.diffPatch(requiredOption("project"), patch.id) : undefined;
      if (!flag("apply")) return print({ patch, validation, diff });
      const version = await core.applyPatch(requiredOption("project"), patch.id);
      const preview = flag("preview") ? await core.renderPreview(requiredOption("project")) : undefined;
      return print({ patch, validation, diff, version, preview });
    }
    case "align": return print(flag("background") ? await core.enqueueJob(requiredOption("project"), "alignment", {}) : await core.enrichTranscript(requiredOption("project")));
    case "visual": return print(flag("background") ? await core.enqueueJob(requiredOption("project"), "visual-analysis", { startUs: secondsToUs(Number(requiredOption("start"))), endUs: secondsToUs(Number(requiredOption("end"))) }) : await core.inspectVisualRange(requiredOption("project"), secondsToUs(Number(requiredOption("start"))), secondsToUs(Number(requiredOption("end")))));
    case "jobs": return print(await core.listJobs(requiredOption("project")));
    case "cancel": return print(await core.cancelJob(requiredOption("project"), positional()[0] ?? (() => { throw new Error("Missing job id"); })()));
    case "doctor": return print(await core.systemStatus());
    case "api": { const token = process.env.VIDEO_AGENT_API_TOKEN; if (!token) throw new Error("VIDEO_AGENT_API_TOKEN is required"); const { startNetworkApi } = await import("../../../packages/api/src/index.js"); const host = option("host") ?? "127.0.0.1"; const port = Number(option("port") ?? 8787); startNetworkApi(core, { token, host, port }); return print({ listening: `http://${host}:${port}`, authentication: "bearer" }); }
    case "eval": await import("../../../evals/run.js"); return;

    case "voice-capabilities": return print(core.voiceCapabilities());
    case "voices": return print(await core.listVoices(requiredOption("project")));
    case "voice-analyze": return print(await core.analyzeVoiceReference(requiredOption("project"), requiredOption("asset"), option("speaker")));
    case "voice-enroll": {
      if (!flag("authorize")) throw new Error("Voice enrollment requires explicit --authorize");
      const projectId = requiredOption("project");
      const request = {
        assetId: requiredOption("asset"),
        name: requiredOption("name"),
        languages: csvOption("languages"),
        authorizationConfirmed: true,
        grantedBy: requiredOption("granted-by"),
        evidence: requiredOption("evidence"),
        ...(option("scope") ? { scope: option("scope")! } : {}),
        ...(option("speaker") ? { speakerId: option("speaker")! } : {}),
        ...(option("provider-authorization") ? { providerAuthorizationId: option("provider-authorization")! } : {}),
        ...(flag("embedding-only") ? { allowEmbeddingOnly: true } : {}),
      };
      return print(flag("background") ? await core.enqueueJob(projectId, "voice-enroll", request) : await core.enrollVoice(projectId, request));
    }
    case "voice-preview": return print(await core.previewVoice(requiredOption("project"), { voiceProfileId: requiredOption("voice-profile"), text: positional().join(" "), language: option("language") ?? "zh" }));
    case "voice-approve": return print(await core.approveVoice(requiredOption("project"), requiredOption("voice-profile")));
    case "voice-design": {
      const pace = option("pace");
      if (pace && !["slow", "moderate", "fast"].includes(pace)) throw new Error("--pace must be slow, moderate, or fast");
      return print(await core.designVoice(requiredOption("project"), {
        description: positional().join(" "),
        language: option("language") ?? "zh",
        sampleText: requiredOption("sample"),
        ...(option("tone") ? { tone: option("tone")! } : {}),
        ...(pace ? { pace: pace as "slow" | "moderate" | "fast" } : {}),
        ...(option("age") ? { agePresentation: option("age")! } : {}),
        ...(option("energy") ? { energy: option("energy")! } : {}),
        ...(option("style") ? { style: option("style")! } : {}),
      }));
    }
    case "voice-delete": return print(await core.deleteVoice(requiredOption("project"), requiredOption("voice-profile")));
    case "narration": return print(await core.addNarration(requiredOption("project"), { text: positional().join(" "), voiceId: option("voice") ?? "narrator-1", language: option("language") ?? "zh", timelineInUs: secondsToUs(Number(option("at") ?? 0)), ...(option("target") ? { targetDurationUs: secondsToUs(Number(option("target"))) } : {}), ...(option("overflow") ? { actionOnOverflow: option("overflow") as "extend" | "fail" } : {}) }));

    case "versions": return print(await core.listVersions(requiredOption("project")));
    case "restore": return print(await core.restoreVersion(requiredOption("project"), Number(requiredOption("version"))));
    case "approve-final": return print(await core.approveFinal(requiredOption("project")));
    case "export": return print(await core.exportVideo(requiredOption("project")));
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
