// `node scripts/performance/generate-resilience-report.mjs <path-to-benchmark-or-soak-report.json>`
// Renders one raw .runtime/resilience/*.json report (benchmark or soak) into a
// secret-safe markdown summary suitable for pasting into
// docs/resilience-capacity-envelope.md. Never touches git; a human decides
// what, if anything, gets committed to docs.

import { readFileSync } from "node:fs";

import { log, logError } from "../lab/common.mjs";

const FORBIDDEN_KEY_PATTERN = /username|hostname|^ip$|ipaddress|credential|secret|token|password/i;

function assertSecretSafe(value, path = "") {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new Error(`report contains a forbidden field: ${path}${key}`);
      }
      assertSecretSafe(child, `${path}${key}.`);
    }
  }
}

export function renderResilienceReportMarkdown(report) {
  assertSecretSafe(report);
  const lines = [];
  lines.push(`## resilience ${report.kind} report`);
  lines.push("");
  lines.push("### Environment fingerprint");
  lines.push("```json");
  lines.push(JSON.stringify(report.environment, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Measurements");
  lines.push("```json");
  lines.push(JSON.stringify(report.measurements ?? report, null, 2));
  lines.push("```");
  return lines.join("\n");
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    const inputPath = process.argv[2];
    if (!inputPath) throw new Error("usage: generate-resilience-report.mjs <path-to-report.json>");
    const report = JSON.parse(readFileSync(inputPath, "utf8"));
    log(renderResilienceReportMarkdown(report));
  } catch (error) {
    logError(`generate-resilience-report FAILED: ${error.message}`);
    process.exit(1);
  }
}
