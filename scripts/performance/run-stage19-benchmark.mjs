// `pnpm lab:stage19:benchmark` — reference-lab measurement run. Reuses the
// exact same real measurement functions as test:stage19:resilience (browser
// budgets, proxy latency, ingestion visibility, 26-query catalog,
// container resources) plus the full environment fingerprint, and writes a
// secret-safe report to .runtime/stage19/ (gitignored, never auto-committed).
// Never prints or writes a raw secret/credential/hostname/IP.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertExactLabToolchain, log, logError, repoRoot } from "../lab/common.mjs";
import { collectEnvironmentFingerprint } from "./lib/environment-fingerprint.mjs";
import { runNotificationReadinessProbe } from "./lib/notification-probe-io.mjs";
import {
  measureBrowserBudgets,
  measureContainerResourceRecovery,
  measureIngestionVisibility,
  measureProxyLatency,
  measureQueryCatalogPerformance,
} from "./verify-stage19-resilience.mjs";

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

export async function runStage19Benchmark({ profile = "normal" } = {}) {
  const environment = collectEnvironmentFingerprint({ workloadProfile: profile });

  log("lab:stage19:benchmark — browser budgets (Chromium + Firefox)...");
  const browser = await measureBrowserBudgets();

  log("lab:stage19:benchmark — proxy latency...");
  const proxy = await measureProxyLatency();

  log("lab:stage19:benchmark — ingestion visibility canary...");
  const ingestion = await measureIngestionVisibility();

  log("lab:stage19:benchmark — 26-query catalog...");
  const queryCatalog = await measureQueryCatalogPerformance();

  log("lab:stage19:benchmark — notification readiness...");
  const notification = await runNotificationReadinessProbe();

  log("lab:stage19:benchmark — container resource snapshot...");
  const resources = await measureContainerResourceRecovery();

  const allRecordAction = browser.flatMap((r) => r.durationsMs.recordAction).sort((a, b) => a - b);
  const allRecordError = browser.flatMap((r) => r.durationsMs.recordError).sort((a, b) => a - b);

  const report = {
    schemaVersion: 1,
    kind: "stage19-benchmark",
    environment,
    measurements: {
      browser: {
        "recordAction.p50": percentile(allRecordAction, 50),
        "recordAction.p95": percentile(allRecordAction, 95),
        "recordAction.p99": percentile(allRecordAction, 99),
        "recordError.p50": percentile(allRecordError, 50),
        "recordError.p95": percentile(allRecordError, 95),
        engines: browser.map((r) => ({
          engine: r.engine,
          consoleErrorCount: r.consoleErrors.length,
        })),
      },
      proxy: {
        "ingest.p95": proxy.p95,
        unexpected5xx: proxy.unexpected5xx,
        sampleCount: proxy.sampleCount,
      },
      ingestion: { visibilityMs: ingestion.visibilityMs, accepted: ingestion.accepted },
      queryCatalog: {
        p95: queryCatalog.p95,
        allSucceeded: queryCatalog.allSucceeded,
        allWithinOwnBudget: queryCatalog.allWithinOwnBudget,
        manifestCount: queryCatalog.results.length,
      },
      notification: {
        status: notification.status,
        firingLatencyMs: notification.firingLatencyMs,
        resolvedLatencyMs: notification.resolvedLatencyMs,
      },
      containerResources: resources,
    },
  };

  const outDir = join(repoRoot, ".runtime/stage19");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `benchmark-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  log(
    `lab:stage19:benchmark — report written to ${outPath} (not committed, .runtime/ is gitignored)`,
  );
  return report;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:stage19:benchmark");
    await runStage19Benchmark();
    log("lab:stage19:benchmark complete.");
  } catch (error) {
    logError(`lab:stage19:benchmark FAILED: ${error.message}`);
    process.exit(1);
  }
}
