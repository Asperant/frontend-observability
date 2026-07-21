// `pnpm lab:stage19:soak [--duration=60m]` — mixed-workload soak run:
// periodic query + alert-readiness probes, one restart cycle, periodic
// container-resource sampling, and post-load leak/recovery analysis.
// Duration accepts `<number><s|m|h>` (e.g. `--duration=90s`, `--duration=15m`,
// `--duration=1h`); defaults to 60m per Stage 19's standard profile.
// Writes a secret-safe report to .runtime/stage19/ (gitignored, never
// auto-committed, never auto-writes back to git).

import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  log,
  logError,
  repoRoot,
  runDockerCompose,
} from "../lab/common.mjs";
import { waitForHealthy } from "../lab/wait.mjs";
import { killSwitchOff, killSwitchOn } from "../lab/kill-switch.mjs";
import { readCurrentRuntimeControl } from "../lab/generate-runtime-control.mjs";
import { collectEnvironmentFingerprint } from "./lib/environment-fingerprint.mjs";
import { runNotificationReadinessProbe } from "./lib/notification-probe-io.mjs";
import {
  readAllRestartCounts,
  sampleContainerMetrics,
  sampleFileDescriptorCount,
} from "./collect-container-metrics.mjs";
import { aggregateContainerSeries } from "./lib/metrics-collector.js";
import {
  measureIngestionVisibility,
  measureProxyLatency,
  measureQueryCatalogPerformance,
  requestProxy,
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
const PROXY_ORIGIN = "https://localhost:8443";
const LOGS_PATH = "/rum/v1/default/logs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logPayload(message) {
  return JSON.stringify({
    date: Date.now(),
    message,
    status: "info",
    service: "chicek-demo-frontend",
    env: "lab",
    version: "0.1.0",
  });
}

async function runBrowserWorkload(browserType) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(PROXY_ORIGIN, { waitUntil: "networkidle" });
  await page.getByTestId("status-panel").waitFor({ timeout: 20_000 });
  const scenarioIds = [
    "initialize-runtime-config",
    "consent-grant",
    "record-action",
    "record-error",
    "resource-error",
    "long-task",
    "pii-redacted-action",
    "pii-redacted-error",
    "secret-dropped-action",
    "secret-dropped-error",
    "unsafe-attributes",
    "network-url-sanitization",
  ];
  for (const id of scenarioIds) {
    await page.getByTestId(`scenario-${id}`).click();
    await page.waitForTimeout(100);
  }
  await page.getByTestId("scenario-shutdown").click();
  await browser.close();
  return { engine: browserType.name(), scenarios: scenarioIds.length };
}

async function runBrowserWorkloadPair() {
  const results = await Promise.all([runBrowserWorkload(chromium), runBrowserWorkload(firefox)]);
  return {
    engines: results.map((result) => result.engine),
    scenarioClicks: results.reduce((sum, result) => sum + result.scenarios, 0),
  };
}

async function runBurstProbe() {
  const responses = await Promise.all(
    Array.from({ length: 60 }, (_, index) =>
      requestProxy(LOGS_PATH, { body: logPayload(`stage19-soak-burst-${index}`) }),
    ),
  );
  return summarizeResponses(responses, { expectedDropStatuses: new Set([429]) });
}

async function runKillSwitchCycle() {
  await killSwitchOn({ reason: "operator_request" });
  try {
    const blocked = await requestProxy(LOGS_PATH, {
      body: logPayload("stage19-soak-kill-switch-blocked"),
    });
    return summarizeResponses([blocked], { expectedDropStatuses: new Set([410]) });
  } finally {
    await killSwitchOff();
  }
}

function summarizeResponses(responses, { expectedDropStatuses }) {
  const summary = {
    sent: responses.length,
    accepted: 0,
    expectedDrop: 0,
    unexpectedDrop: 0,
    unexpected5xx: 0,
    statusCounts: {},
  };
  for (const response of responses) {
    const status = response.statusCode;
    summary.statusCounts[status] = (summary.statusCounts[status] ?? 0) + 1;
    if (status >= 200 && status < 300) {
      summary.accepted += 1;
    } else if (expectedDropStatuses.has(status)) {
      summary.expectedDrop += 1;
    } else {
      summary.unexpectedDrop += 1;
      if (status >= 500) summary.unexpected5xx += 1;
    }
  }
  return summary;
}

function mergeTrafficSummary(target, source) {
  target.sent += source.sent;
  target.accepted += source.accepted;
  target.expectedDrop += source.expectedDrop;
  target.unexpectedDrop += source.unexpectedDrop;
  target.unexpected5xx += source.unexpected5xx;
  for (const [status, count] of Object.entries(source.statusCounts)) {
    target.statusCounts[status] = (target.statusCounts[status] ?? 0) + count;
  }
}

function sampleOpenObserveDiskKiB() {
  const result = spawnSync("docker", ["exec", "chicek-lab-openobserve-1", "du", "-sk", "/data"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = Number.parseInt(result.stdout.trim().split(/\s+/)[0], 10);
  return Number.isFinite(value) ? value : null;
}

function runtimeControlFreshness() {
  const document = readCurrentRuntimeControl();
  if (!document) return { available: false };
  const now = Date.now();
  return {
    available: true,
    killSwitchActive: document.killSwitch?.active === true,
    ageMs: now - new Date(document.issuedAt).getTime(),
    ttlRemainingMs: new Date(document.expiresAt).getTime() - now,
    revision: document.revision,
  };
}

export async function runStage19Soak({ durationMs }) {
  const environment = collectEnvironmentFingerprint({
    workloadProfile: `sustained/soak-${durationMs}ms`,
  });
  const startedAtMs = Date.now();
  const endAtMs = startedAtMs + durationMs;

  const samplesByService = {};
  const fdSamplesByService = {};
  const diskKiBSeries = [];
  const runtimeControlFreshnessSeries = [];
  const proxyLatencies = [];
  const notificationResults = [];
  const browserWorkloads = [];
  const traffic = {
    sent: 0,
    accepted: 0,
    expectedDrop: 0,
    unexpectedDrop: 0,
    unexpected5xx: 0,
    statusCounts: {},
  };
  const restartCountsBefore = readAllRestartCounts();
  let restartCycleResult = null;
  let nextSampleAt = startedAtMs;
  let nextQueryAt = startedAtMs + QUERY_INTERVAL_MS;
  let nextAlertProbeAt = startedAtMs + ALERT_PROBE_INTERVAL_MS;
  let restartDone = false;
  let burstDone = false;
  let killSwitchCycleDone = false;
  let secondBrowserWorkloadDone = false;

  log(`lab:stage19:soak — running for ${durationMs}ms (ends ${new Date(endAtMs).toISOString()})`);
  browserWorkloads.push(await runBrowserWorkloadPair());

  while (Date.now() < endAtMs) {
    const now = Date.now();

    if (now >= nextSampleAt) {
      const snapshot = sampleContainerMetrics();
      for (const [service, sample] of Object.entries(snapshot)) {
        samplesByService[service] ??= [];
        samplesByService[service].push(sample);
      }
      for (const service of Object.keys(snapshot)) {
        const fd = sampleFileDescriptorCount(service);
        if (fd !== null) {
          fdSamplesByService[service] ??= [];
          fdSamplesByService[service].push(fd);
        }
      }
      diskKiBSeries.push(sampleOpenObserveDiskKiB());
      runtimeControlFreshnessSeries.push(runtimeControlFreshness());
      const proxyProbe = await measureProxyLatency();
      proxyLatencies.push(proxyProbe.p95);
      mergeTrafficSummary(traffic, {
        sent: proxyProbe.sampleCount,
        accepted: Object.entries(proxyProbe.statusCounts)
          .filter(([status]) => Number(status) >= 200 && Number(status) < 300)
          .reduce((sum, [, count]) => sum + count, 0),
        expectedDrop: proxyProbe.statusCounts[429] ?? 0,
        unexpectedDrop: Object.entries(proxyProbe.statusCounts)
          .filter(([status]) => {
            const code = Number(status);
            return code !== 429 && (code < 200 || code >= 300);
          })
          .reduce((sum, [, count]) => sum + count, 0),
        unexpected5xx: proxyProbe.unexpected5xx,
        statusCounts: proxyProbe.statusCounts,
      });
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

    if (!burstDone && now >= startedAtMs + durationMs / 4) {
      burstDone = true;
      mergeTrafficSummary(traffic, await runBurstProbe());
    }

    if (!killSwitchCycleDone && now >= startedAtMs + durationMs / 3) {
      killSwitchCycleDone = true;
      mergeTrafficSummary(traffic, await runKillSwitchCycle());
    }

    if (!secondBrowserWorkloadDone && now >= startedAtMs + (durationMs * 2) / 3) {
      secondBrowserWorkloadDone = true;
      browserWorkloads.push(await runBrowserWorkloadPair());
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

    await sleep(1000);
  }

  const finalSnapshot = sampleContainerMetrics();
  for (const [service, sample] of Object.entries(finalSnapshot)) {
    samplesByService[service] ??= [];
    samplesByService[service].push(sample);
  }
  for (const service of Object.keys(finalSnapshot)) {
    const fd = sampleFileDescriptorCount(service);
    if (fd !== null) {
      fdSamplesByService[service] ??= [];
      fdSamplesByService[service].push(fd);
    }
  }
  diskKiBSeries.push(sampleOpenObserveDiskKiB());
  runtimeControlFreshnessSeries.push(runtimeControlFreshness());
  const finalMarker = await measureIngestionVisibility();
  const restartCountsAfter = readAllRestartCounts();

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
    traffic,
    browserWorkloads,
    notificationProbeResults: notificationResults.map((r) => ({ status: r.status })),
    restartCycle: restartCycleResult,
    restartCounts: { before: restartCountsBefore, after: restartCountsAfter },
    finalMarker,
    perServiceAggregate,
    fdSamplesByService,
    diskKiBSeries,
    runtimeControlFreshnessSeries,
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
      `lab:stage19:soak complete. anyLeakFlagged=${report.anyLeakFlagged} restartCycle.healthRecovered=${report.restartCycle?.healthRecovered} unexpectedDrop=${report.traffic.unexpectedDrop} finalMarkerVisible=${report.finalMarker.visibilityMs !== null}`,
    );
    const notificationFailed = report.notificationProbeResults.some(
      (result) => result.status === "FAILED",
    );
    const runtimeControlStale = report.runtimeControlFreshnessSeries.some(
      (sample) => sample.available !== true || sample.ttlRemainingMs <= 0,
    );
    process.exit(
      report.anyLeakFlagged ||
        report.restartCycle?.healthRecovered === false ||
        report.traffic.unexpectedDrop > 0 ||
        notificationFailed ||
        runtimeControlStale ||
        report.finalMarker.visibilityMs === null
        ? 1
        : 0,
    );
  } catch (error) {
    logError(`lab:stage19:soak FAILED: ${error.message}`);
    process.exit(1);
  }
}
