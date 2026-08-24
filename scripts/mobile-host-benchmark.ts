import { performance } from "node:perf_hooks";
import { MobileHostRuntime } from "../packages/runtime/src/index.js";

const iterations = 100; const samples: number[] = []; let last;
for (let index = 0; index < iterations; index += 1) { const host = new MobileHostRuntime(); const started = performance.now(); last = await host.runZeroServerDemo(); samples.push(performance.now() - started); await host.queue.shutdown(true); }
samples.sort((a, b) => a - b); const percentile = (value: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * value))]!;
process.stdout.write(`${JSON.stringify({ benchmark: "mobile-host-zero-server-simulation", host: `${process.platform}-${process.arch}`, node: process.version, iterations, medianMs: Number(percentile(0.5).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)), maxMs: Number(samples.at(-1)!.toFixed(3)), finalVersion: last?.version.version, backendRequests: last?.backendRequests, scope: "portable orchestration + in-memory storage + deterministic ASR/planner/render fixtures; not media codec or device ML performance" }, null, 2)}\n`);
