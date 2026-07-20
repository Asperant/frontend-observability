// `pnpm lab:stage19:soak [--duration=60m]` — mixed-workload soak run:
// periodic query + alert-readiness probes, one restart cycle, periodic
// container-resource sampling, and post-load leak/recovery analysis.
// Duration accepts `<number><s|m|h>` (e.g. `--duration=90s`, `--duration=15m`,
// `--duration=1h`); defaults to 60m per Stage 19's standard profile.
// Writes a secret-safe report to .runtime/stage19/ (gitignored, never
// auto-committed, never auto-writes back to git).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertExactLabToolchain,
  log,
  logError,
  repoRoot,
  runDockerCompose,
} from "../lab/common.mjs";
import { waitForHealthy } from "../lab/wait.mjs";
import { collectEnvironmentFingerprint } from "./lib/environment-fingerprint.mjs";
import { runNotificationReadinessProbe } from "./lib/notification-probe-io.mjs";
import { sampleContainerMetrics } from "./collect-container-metrics.mjs";
import { aggregateContainerSeries } from "./lib/metrics-collector.js";
import {
  measureIngestionVisibility,
  measureProxyLatency,
  measureQueryCatalogPerformance,
} from "./verify-stage19-resilience.mjs";

const DURATION_PATTERN = /^(\d+)(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(text) {
  const match = DURATION_PATTERN.exec(text);
  if (!match) {
    throw new Error(`invalid --duration value "${text}"; expected e.g. "90s", "15m", "60m", "1h"`);
  }
  const [, amount, unit] = match;
  return Number.parseInt(amount, 10) * UNIT_MS[unit];
}

function parseArgs(argv) {
  const durationArg = argv.find((arg) => arg.startsWith("--duration="));
  return { durationMs: parseDuration(durationArg ? durationArg.split("=")[1] : "60m") };
}

const SAMPLE_INTERVAL_MS = 30_000;
const QUERY_INTERVAL_MS = 60_000;
const ALERT_PROBE_INTERVAL_MS = 90_000;

export async function runStage19Soak({ durationMs }) {
  const environment = collectEnvironmentFingerprint({
    workloadProfile: `sustained/soak-${durationMs}ms`,
  });
  const startedAtMs = Date.now();
  const endAtMs = startedAtMs + durationMs;

  const samplesByService = {};
  const proxyLatencies = [];
  const notificationResults = [];
  let restartCycleResult = null;
  let nextSampleAt = startedAtMs;
  let nextQueryAt = startedAtMs + QUERY_INTERVAL_MS;
  let nextAlertProbeAt = startedAtMs + ALERT_PROBE_INTERVAL_MS;
  let restartDone = false;

  log(`lab:stage19:soak — running for ${durationMs}ms (ends ${new Date(endAtMs).toISOString()})`);

  while (Date.now() < endAtMs) {
    const now = Date.now();

    if (now >= nextSampleAt) {
      const snapshot = sampleContainerMetrics();
      for (const [service, sample] of Object.entries(snapshot)) {
        samplesByService[service] ??= [];
        samplesByService[service].push(sample);
      }
      const proxyProbe = await measureProxyLatency();
      proxyLatencies.push(proxyProbe.p95);
      nextSampleAt = now + SAMPLE_INTERVAL_MS;
    }

    if (now >= nextQueryAt) {
      await measureQueryCatalogPerformance();
      nextQueryAt = now + QUERY_INTERVAL_MS;
    }

    if (now >= nextAlertProbeAt) {
      notificationResults.push(await runNotificationReadinessProbe());
      nextAlertProbeAt = now + ALERT_PROBE_INTERVAL_MS;
    }

    // One restart cycle roughly at the midpoint of the run.
    if (!restartDone && now >= startedAtMs + durationMs / 2) {
      restartDone = true;
      const restartIssuedAtMs = Date.now();
      runDockerCompose(["restart", "openobserve"]);
      const health = await waitForHealthy({
        services: ["openobserve", "alert-sink"],
        timeoutMs: 90_000,
      });
      const ingestion = await measureIngestionVisibility();
      restartCycleResult = {
        healthRecovered: health.healthy,
        recoveryTimeMs: Date.now() - restartIssuedAtMs,
        postRestartIngestionVisibilityMs: ingestion.visibilityMs,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const finalSnapshot = sampleContainerMetrics();
  for (const [service, sample] of Object.entries(finalSnapshot)) {
    samplesByService[service] ??= [];
    samplesByService[service].push(sample);
  }

  const perServiceAggregate = {};
  for (const [service, samples] of Object.entries(samplesByService)) {
    if (samples.length < 3) continue;
    perServiceAggregate[service] = aggregateContainerSeries(samples);
  }
  const memoryTrendLeakFlags = Object.fromEntries(
    Object.entries(perServiceAggregate).map(([service, agg]) => [
      service,
      agg.memoryTrend.classification === "growing",
    ]),
  );

  const report = {
    schemaVersion: 1,
    kind: "stage19-soak",
    environment,
    durationMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date().toISOString(),
    sampleCounts: Object.fromEntries(
      Object.entries(samplesByService).map(([s, v]) => [s, v.length]),
    ),
    proxyLatencyP95Series: proxyLatencies,
    notificationProbeResults: notificationResults.map((r) => ({ status: r.status })),
    restartCycle: restartCycleResult,
    perServiceAggregate,
    memoryTrendLeakFlags,
    anyLeakFlagged: Object.values(memoryTrendLeakFlags).some(Boolean),
  };

  const outDir = join(repoRoot, ".runtime/stage19");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `soak-${startedAtMs}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  log(`lab:stage19:soak — report written to ${outPath} (not committed, .runtime/ is gitignored)`);
  return report;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:stage19:soak");
    const { durationMs } = parseArgs(process.argv.slice(2));
    const report = await runStage19Soak({ durationMs });
    log(
      `lab:stage19:soak complete. anyLeakFlagged=${report.anyLeakFlagged} restartCycle.healthRecovered=${report.restartCycle?.healthRecovered}`,
    );
    process.exit(report.anyLeakFlagged || report.restartCycle?.healthRecovered === false ? 1 : 0);
  } catch (error) {
    logError(`lab:stage19:soak FAILED: ${error.message}`);
    process.exit(1);
  }
}
