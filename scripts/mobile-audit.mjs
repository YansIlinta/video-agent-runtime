#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mobileDir = path.join(root, "apps", "mobile");
const allowlistPath = path.join(mobileDir, "security-audit-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const audit = spawnSync(npm, ["audit", "--omit=dev", "--json"], {
  cwd: mobileDir,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});

if (audit.error) throw audit.error;
if (!audit.stdout?.trim()) {
  process.stderr.write(audit.stderr ?? "npm audit produced no JSON output\n");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch (error) {
  process.stderr.write(`Could not parse npm audit JSON: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(audit.stdout.slice(0, 4000));
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const metadata = report.metadata?.vulnerabilities ?? {};
const criticalCount = Number(metadata.critical ?? 0);
const highEntries = Object.values(vulnerabilities).filter((entry) => entry?.severity === "high");
const highPackages = new Set(highEntries.map((entry) => entry.name));
const allowedPackages = new Set(allowlist.allowedPackages ?? []);
const allowedAdvisories = new Set(allowlist.allowedAdvisories ?? []);
const observedAdvisories = new Set();
const unknownDirectAdvisories = [];

for (const entry of highEntries) {
  for (const via of entry.via ?? []) {
    if (!via || typeof via !== "object") continue;
    const match = typeof via.url === "string" ? via.url.match(/GHSA-[A-Za-z0-9-]+/) : null;
    if (!match) continue;
    const id = match[0];
    observedAdvisories.add(id);
    if (!allowedAdvisories.has(id) || (via.name ?? via.dependency) !== "image-size") {
      unknownDirectAdvisories.push({ package: entry.name, advisory: id, sourcePackage: via.name ?? via.dependency ?? null });
    }
  }
}

const unknownPackages = [...highPackages].filter((name) => !allowedPackages.has(name));
const missingKnownRoot = highEntries.length > 0 && !highPackages.has("image-size");
const unknownObservedAdvisories = [...observedAdvisories].filter((id) => !allowedAdvisories.has(id));
const reviewDue = new Date(`${allowlist.reviewDue}T23:59:59Z`);
const exceptionExpired = Number.isNaN(reviewDue.getTime()) || (highEntries.length > 0 && Date.now() > reviewDue.getTime());

const problems = [];
if (criticalCount > 0) problems.push(`${criticalCount} critical vulnerabilities reported`);
if (unknownPackages.length) problems.push(`unexpected high-severity packages: ${unknownPackages.join(", ")}`);
if (unknownObservedAdvisories.length) problems.push(`unexpected high-severity advisories: ${unknownObservedAdvisories.join(", ")}`);
if (unknownDirectAdvisories.length) problems.push(`unexpected direct advisories: ${JSON.stringify(unknownDirectAdvisories)}`);
if (missingKnownRoot) problems.push("high-severity findings no longer root at image-size; re-triage the dependency graph");
if (exceptionExpired) problems.push(`mobile audit exception expired on ${allowlist.reviewDue}`);

const summary = {
  status: problems.length === 0 ? (highEntries.length === 0 ? "clean" : "allowed-temporary-exception") : "failed",
  highCount: Number(metadata.high ?? highEntries.length),
  criticalCount,
  highPackages: [...highPackages].sort(),
  observedAdvisories: [...observedAdvisories].sort(),
  reviewDue: allowlist.reviewDue,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (problems.length) {
  for (const problem of problems) process.stderr.write(`mobile-audit: ${problem}\n`);
  process.exit(1);
}
