import { fitSpeechToRange } from "../packages/speech/src/index.js";

const realEnabled = process.env.VIDEO_AGENT_EVAL_REAL_VOICE === "true";
const metrics = ["asrWerCer", "diarizationError", "alignmentError", "speakerSimilarity", "intelligibility", "durationFitError", "longFormDrift", "crossLanguageConsistency", "loudnessVariance", "firstAudioLatency", "realTimeFactor", "vram", "peakMemory"];
const result = { mode: realEnabled ? "real-provider-requested" : "offline-default", deterministicFitChecks: [fitSpeechToRange(3_500_000, 3_200_000).action, fitSpeechToRange(4_900_000, 3_200_000).action], metrics: Object.fromEntries(metrics.map((metric) => [metric, { status: "not-executed", reason: realEnabled ? "No benchmark corpus/provider runner has been configured for this metric" : "Set VIDEO_AGENT_EVAL_REAL_VOICE=true and configure the required provider runtime/credentials" }])) };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (realEnabled) process.exitCode = 2;
