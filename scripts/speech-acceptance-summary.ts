import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const inputDirectory = path.resolve(process.env.VIDEO_AGENT_ACCEPTANCE_RESULTS ?? "evals/results");
const jsonOutput = path.resolve(process.env.VIDEO_AGENT_ACCEPTANCE_SUMMARY_JSON ?? path.join(inputDirectory, "speech-benchmark-summary.json"));
const markdownOutput = path.resolve(process.env.VIDEO_AGENT_ACCEPTANCE_SUMMARY_MD ?? path.join(inputDirectory, "speech-benchmark-summary.md"));
const stages = ["asr", "llm", "tts", "clone"] as const;
type Stage = typeof stages[number];
type StageStatus = "passed" | "failed" | "blocked" | "skipped";

interface ProviderInfo { id?: string; model?: string }
interface StageMeasurement {
  status?: StageStatus;
  wallMs?: number;
  controllerPeakRssMiB?: number;
  systemGpuPeakUsedMiB?: number;
  value?: Record<string, unknown>;
}
interface AcceptanceReport {
  mode?: string;
  startedAt?: string;
  finishedAt?: string;
  providers?: { asr?: ProviderInfo; planner?: ProviderInfo; tts?: ProviderInfo; voice?: ProviderInfo };
  stages?: Partial<Record<Stage, StageMeasurement>>;
}
interface Sample {
  stage: Stage;
  provider: string;
  model: string;
  status: StageStatus;
  startedAt?: string;
  wallMs?: number;
  controllerPeakRssMiB?: number;
  systemGpuPeakUsedMiB?: number;
  realTimeFactor?: number;
}

function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function percentile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(rank, sorted.length - 1)];
}
function rounded(value: number | undefined, digits = 2) { return value === undefined ? undefined : Number(value.toFixed(digits)); }
function providerFor(report: AcceptanceReport, stage: Stage): ProviderInfo | undefined {
  if (stage === "asr") return report.providers?.asr;
  if (stage === "llm") return report.providers?.planner;
  if (stage === "tts") return report.providers?.tts;
  return report.providers?.voice ?? report.providers?.tts;
}

const entries = await readdir(inputDirectory, { withFileTypes: true }).catch(() => []);
const files = entries.filter((entry) => entry.isFile() && /^real-speech-acceptance-.*\.json$/u.test(entry.name)).map((entry) => path.join(inputDirectory, entry.name)).sort();
const samples: Sample[] = [];
let invalidReports = 0;
let disabledReports = 0;

for (const file of files) {
  try {
    const report = JSON.parse(await readFile(file, "utf8")) as AcceptanceReport;
    if (report.mode !== "real-provider") { disabledReports += 1; continue; }
    for (const stage of stages) {
      const measurement = report.stages?.[stage];
      if (!measurement?.status) continue;
      const provider = providerFor(report, stage);
      const realTimeFactor = finite(measurement.value?.realTimeFactor);
      samples.push({
        stage,
        provider: provider?.id ?? "unknown",
        model: provider?.model ?? "unknown",
        status: measurement.status,
        ...(report.startedAt ? { startedAt: report.startedAt } : {}),
        ...(finite(measurement.wallMs) === undefined ? {} : { wallMs: measurement.wallMs }),
        ...(finite(measurement.controllerPeakRssMiB) === undefined ? {} : { controllerPeakRssMiB: measurement.controllerPeakRssMiB }),
        ...(finite(measurement.systemGpuPeakUsedMiB) === undefined ? {} : { systemGpuPeakUsedMiB: measurement.systemGpuPeakUsedMiB }),
        ...(realTimeFactor === undefined ? {} : { realTimeFactor }),
      });
    }
  } catch {
    invalidReports += 1;
  }
}

const grouped = new Map<string, Sample[]>();
for (const sample of samples) {
  const key = `${sample.stage}\u0000${sample.provider}\u0000${sample.model}`;
  const bucket = grouped.get(key) ?? [];
  bucket.push(sample);
  grouped.set(key, bucket);
}

const rows = [...grouped.values()].map((group) => {
  const first = group[0]!;
  const passed = group.filter((sample) => sample.status === "passed");
  const walls = passed.map((sample) => sample.wallMs).filter((value): value is number => value !== undefined);
  const rtfs = passed.map((sample) => sample.realTimeFactor).filter((value): value is number => value !== undefined);
  const rss = passed.map((sample) => sample.controllerPeakRssMiB).filter((value): value is number => value !== undefined);
  const gpu = passed.map((sample) => sample.systemGpuPeakUsedMiB).filter((value): value is number => value !== undefined);
  const timestamps = group.map((sample) => sample.startedAt).filter((value): value is string => Boolean(value)).sort();
  return {
    stage: first.stage,
    provider: first.provider,
    model: first.model,
    runs: group.length,
    passed: passed.length,
    failed: group.filter((sample) => sample.status === "failed").length,
    blocked: group.filter((sample) => sample.status === "blocked").length,
    skipped: group.filter((sample) => sample.status === "skipped").length,
    latestRunAt: timestamps.at(-1),
    wallMsP50: rounded(percentile(walls, 0.5), 0),
    wallMsP95: rounded(percentile(walls, 0.95), 0),
    realTimeFactorP50: rounded(percentile(rtfs, 0.5), 3),
    realTimeFactorP95: rounded(percentile(rtfs, 0.95), 3),
    controllerPeakRssMiBP95: rounded(percentile(rss, 0.95), 1),
    systemGpuPeakUsedMiBP95: rounded(percentile(gpu, 0.95), 0),
  };
}).sort((a, b) => a.stage.localeCompare(b.stage) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceDirectory: inputDirectory,
  reportFiles: files.length,
  realProviderSamples: samples.length,
  disabledReports,
  invalidReports,
  rows,
  measurementNotes: {
    controllerPeakRssMiBP95: "Node acceptance-controller RSS only; child Python/native model memory is not included.",
    systemGpuPeakUsedMiBP95: "Coarse machine-level GPU memory from nvidia-smi when available; not process-attributed VRAM.",
    realTimeFactor: "Wall seconds divided by input/generated audio seconds. Lower is faster; only present for ASR/TTS reports that recorded it.",
  },
};

const cell = (value: unknown) => value === undefined ? "—" : String(value).replace(/\|/gu, "\\|");
const markdown = [
  "# Real speech benchmark summary",
  "",
  `Generated: ${summary.generatedAt}`,
  "",
  `Reports discovered: ${files.length}; real-provider stage samples: ${samples.length}; disabled reports ignored: ${disabledReports}; invalid reports: ${invalidReports}.`,
  "",
  "| Stage | Provider | Model | Runs | Pass | Fail | Block | P50 wall ms | P95 wall ms | P50 RTF | P95 RTF | P95 controller RSS MiB | P95 system GPU MiB | Latest |",
  "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ...rows.map((row) => `| ${cell(row.stage)} | ${cell(row.provider)} | ${cell(row.model)} | ${row.runs} | ${row.passed} | ${row.failed} | ${row.blocked} | ${cell(row.wallMsP50)} | ${cell(row.wallMsP95)} | ${cell(row.realTimeFactorP50)} | ${cell(row.realTimeFactorP95)} | ${cell(row.controllerPeakRssMiBP95)} | ${cell(row.systemGpuPeakUsedMiBP95)} | ${cell(row.latestRunAt)} |`),
  "",
  "> RSS is the Node controller only. GPU memory is coarse machine-level usage. Do not present either as model-process peak memory without process-attributed measurement.",
  "",
].join("\n");

await writeFile(jsonOutput, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(markdownOutput, markdown, "utf8");
process.stdout.write(`${JSON.stringify({ jsonOutput, markdownOutput, rows: rows.length, realProviderSamples: samples.length, invalidReports }, null, 2)}\n`);
