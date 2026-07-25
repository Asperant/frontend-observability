// `pnpm test:resilience` — resilience acceptance gate: performance
// budgets, restart-recovery timing/drift, notification readiness, and
// failure isolation. Short and deterministic (per resilience's own scope) —
// full-fidelity reference-lab measurement lives in run-resilience-benchmark.mjs
// and run-resilience-soak.mjs, not here. Never prints a raw secret/credential.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  caCertPath,
  log,
  logError,
  repoRoot,
  runDockerCompose,
  runtimeControlDaemonPidPath,
  stopDetachedProcess,
} from "../lab/common.mjs";
import { waitForHealthy } from "../lab/wait.mjs";
import { readAdminAuthHeader, listPipelines, search } from "../lab/streams/admin-client.mjs";
import { streamsVerify } from "../lab/streams-verify.mjs";
import { dashboardsStatus } from "../lab/dashboards-status.mjs";
import { alertsStatus } from "../lab/alerts-status.mjs";
import { createAlert, deleteAlert, getAlert } from "../lab/alerts/admin-client.mjs";
import { buildOpenObserveAlert } from "../lab/alerts/alert-builder.js";
import { loadAllAlertPolicies, loadAlertTemplates } from "../lab/alerts/catalog.mjs";
import { LOCAL_DESTINATION_NAME } from "../lab/alerts-install-starters.mjs";
import { loadAllQueryManifests } from "../lab/dashboards/catalog.mjs";
import { renderQueryTemplate } from "../lab/dashboards/sql-template.js";
import { killSwitchOff, killSwitchOn } from "../lab/kill-switch.mjs";
import { readCurrentRuntimeControl } from "../lab/generate-runtime-control.mjs";
import { DEMO_IDENTITY } from "../../tests/fixtures/apps/browser-app/src/identity.js";
import { sampleContainerMetrics, sampleFileDescriptorCount } from "./collect-container-metrics.mjs";
import { evaluateAllBudgets } from "./lib/budget-evaluator.js";
import { computeFdDelta, computeMemoryLimitRatio } from "./lib/metrics-collector.js";
import {
  computeRecoveryTimings,
  detectStateDrift,
  verifyRestartCountExpectation,
} from "./lib/recovery-matrix.js";
import { runNotificationReadinessProbe } from "./lib/notification-probe-io.mjs";
import { NOTIFICATION_READINESS_STATUS } from "./lib/notification-readiness.js";

const PROXY_ORIGIN = "https://localhost:8443";
const DEMO_URL = "https://localhost:8443";
const RUM_PATH = "/rum/v1/default/rum";
const LOGS_PATH = "/rum/v1/default/logs";
const BUDGETS_PATH = new URL(
  "../../infrastructure/performance/resilience-performance-budgets.json",
  import.meta.url,
);
const runtimeControlDaemonScript = fileURLToPath(
  new URL("../lab/runtime-control-refresh-daemon.mjs", import.meta.url),
);

function loadJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

export function requestProxy(
  path,
  { method = "POST", headers = {}, body = "{}", timeoutMs = 15_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = httpsRequest(
      {
        method,
        host: "127.0.0.1",
        port: 8443,
        path,
        headers: {
          Host: "localhost:8443",
          Origin: PROXY_ORIGIN,
          "Content-Type": "text/plain;charset=UTF-8",
          ...headers,
          ...(body !== undefined ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
        ca: readFileSync(caCertPath),
        servername: "localhost",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            elapsedMs: Date.now() - started,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rumPayload(overrides = {}) {
  const sessionId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  return JSON.stringify({
    date: Date.now(),
    type: "view",
    application_id: "chicek-browser-app",
    service: DEMO_IDENTITY.service,
    env: DEMO_IDENTITY.environment,
    version: DEMO_IDENTITY.version,
    session_id: sessionId,
    view_id: viewId,
    view: { id: viewId, url: `${PROXY_ORIGIN}/resilience` },
    session: { id: sessionId },
    ...overrides,
  });
}

function readPidFile(pidPath) {
  if (!existsSync(pidPath)) return null;
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startRuntimeControlDaemon() {
  const child = spawn(process.execPath, [runtimeControlDaemonScript], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(runtimeControlDaemonPidPath, String(child.pid), { mode: 0o600 });
  return child.pid;
}

async function waitForRuntimeControlRevisionAfter(previousRevision, timeoutMs = 10_000) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    const document = readCurrentRuntimeControl();
    if (document && document.revision > previousRevision) return document;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return readCurrentRuntimeControl();
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function restartRuntimeControlAgentScenario() {
  const startedAtMs = Date.now();
  let offResult = null;
  try {
    const onResult = await killSwitchOn({ reason: "operator_request" });
    const beforeRevision = onResult.document.revision;
    const oldPid = readPidFile(runtimeControlDaemonPidPath);
    stopDetachedProcess(runtimeControlDaemonPidPath);
    const oldPidExited = await waitForProcessExit(oldPid);
    const newPid = startRuntimeControlDaemon();
    const refreshed = await waitForRuntimeControlRevisionAfter(beforeRevision);
    offResult = await killSwitchOff();

    return {
      target: "runtime-control-agent",
      healthRecovered: Boolean(refreshed && refreshed.revision > beforeRevision),
      timings: {
        recoveryTimeMs: Date.now() - startedAtMs,
      },
      oldPidAliveAfterStop: isProcessAlive(oldPid),
      oldPidExited,
      newPidAlive: isProcessAlive(newPid),
      killSwitchPreservedDuringRefresh: refreshed?.killSwitch?.active === true,
      previousRevision: beforeRevision,
      refreshedRevision: refreshed?.revision ?? null,
      finalRevision: offResult.document.revision,
    };
  } finally {
    if (!offResult) {
      await killSwitchOff().catch(() => {});
    }
    if (!isProcessAlive(readPidFile(runtimeControlDaemonPidPath))) {
      startRuntimeControlDaemon();
    }
  }
}

// --- 1. lib unit coverage suite -------------------------------------------

function runLibCoverageSuite() {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "lab",
      "tests/performance/resilience/unit",
      "--coverage",
      "--coverage.include=scripts/performance/lib/**/*.js",
    ],
    { encoding: "utf8", cwd: repoRoot },
  );
  return {
    pass: result.status === 0,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-4000),
  };
}

// --- 2. browser budgets (Chromium + Firefox) -------------------------------

async function measureBrowserBudgetsForEngine(browserType) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(DEMO_URL, { waitUntil: "networkidle" });
  await page.getByTestId("status-panel").waitFor({ timeout: 20_000 });
  // "initialize" alone targets a static test-fixture config; only
  // "initialize-runtime-config" resolves to the real lab's generated
  // runtime-config.json (real RUM site/token) — see
  // scripts/lab/verify-openobserve-ingestion.mjs's identical init+consent
  // sequence. Without this, and without consent, nothing here actually
  // reaches OpenObserve and the schema never grows beyond bare canaries.
  await page.getByTestId("scenario-initialize-runtime-config").click();
  await page.getByTestId("scenario-consent-grant").click();
  await page.waitForTimeout(500);

  const durationsMs = await page.evaluate(() => {
    const measure = (testId, samples) => {
      const button = document.querySelector(`[data-testid="${testId}"]`);
      const values = [];
      for (let index = 0; index < samples; index += 1) {
        const start = performance.now();
        button.click();
        values.push(performance.now() - start);
      }
      return values;
    };
    return {
      recordAction: measure("scenario-record-action", 30),
      recordError: measure("scenario-record-error", 30),
      // The largest realistic non-adversarial sanitizer input this app
      // triggers on click: attributes with nested/PII/secret values, which
      // exercises the sanitizer's redaction/traversal path, not just the
      // string-length path.
      sanitizerWorstCase: measure("scenario-unsafe-attributes", 15),
    };
  });

  const heapBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  for (let i = 0; i < 100; i += 1) {
    await page.evaluate(() =>
      document.querySelector('[data-testid="scenario-safe-action"]').click(),
    );
  }
  await page.waitForTimeout(1000);
  const heapAfter = await page.evaluate(() => {
    if (globalThis.gc) globalThis.gc();
    return performance.memory?.usedJSHeapSize ?? null;
  });

  // Seeds event kinds the dashboard-governance query catalog's manifests need
  // (resource/long-task fields) beyond the record-action/record-error
  // clicks above, then forces a flush via the public shutdown API before
  // closing — the SDK's own batch window (~35s) would otherwise outlive
  // this browser session and these events would never reach the network.
  await page.getByTestId("scenario-resource-error").click();
  await page.getByTestId("scenario-long-task").click();
  await page.waitForTimeout(200);
  const flushResponsePromise = page
    .waitForResponse((response) => response.url().includes("/rum/v1/"), { timeout: 10_000 })
    .catch(() => null);
  await page.getByTestId("scenario-shutdown").click();
  await flushResponsePromise;

  await browser.close();

  return {
    engine: browserType.name(),
    durationsMs,
    heapBefore,
    heapAfter,
    consoleErrors,
  };
}

export async function measureBrowserBudgets() {
  const [chromiumResult, firefoxResult] = await Promise.all([
    measureBrowserBudgetsForEngine(chromium),
    measureBrowserBudgetsForEngine(firefox),
  ]);
  return [chromiumResult, firefoxResult];
}

// --- 3. proxy latency / error distribution ---------------------------------

export async function measureProxyLatency() {
  const latencies = [];
  const statusCounts = {};
  let unexpected5xx = 0;
  for (let i = 0; i < 40; i += 1) {
    const response = await requestProxy(LOGS_PATH, {
      body: JSON.stringify({
        date: Date.now(),
        message: "resilience-proxy-latency-probe",
        status: "info",
        service: DEMO_IDENTITY.service,
        env: DEMO_IDENTITY.environment,
        version: DEMO_IDENTITY.version,
      }),
    });
    latencies.push(response.elapsedMs);
    statusCounts[response.statusCode] = (statusCounts[response.statusCode] ?? 0) + 1;
    if (response.statusCode >= 500 && response.statusCode !== 502 && response.statusCode !== 504) {
      unexpected5xx += 1;
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    unexpected5xx,
    statusCounts,
    sampleCount: latencies.length,
  };
}

// --- 4. ingestion visibility canary -----------------------------------------

export async function measureIngestionVisibility() {
  const auth = readAdminAuthHeader();
  const canaryId = `resilience-ingest-canary-${crypto.randomUUID()}`;
  const sentAtMs = Date.now();
  const response = await requestProxy(RUM_PATH, {
    body: rumPayload({ view: { id: canaryId, url: `${PROXY_ORIGIN}/resilience-canary` } }),
  });
  if (response.statusCode >= 300) {
    return { accepted: false, visibilityMs: null };
  }
  const deadlineMs = sentAtMs + 60_000;
  let visibleAtMs = null;
  while (Date.now() < deadlineMs) {
    const result = await search(
      auth,
      `select view_id from _rumdata where view_id = '${canaryId}' limit 1`,
      { startUs: (sentAtMs - 5_000) * 1000, endUs: Date.now() * 1000 },
    );
    if (result.hits.length > 0) {
      visibleAtMs = Date.now();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return {
    accepted: true,
    visibilityMs: visibleAtMs !== null ? visibleAtMs - sentAtMs : null,
  };
}

// --- 5. 30-query catalog performance smoke ---------------------------------

export async function measureQueryCatalogPerformance() {
  const auth = readAdminAuthHeader();
  const manifests = loadAllQueryManifests();
  const results = [];
  const nowUs = () => Date.now() * 1000;
  for (const manifest of manifests) {
    const variables = (manifest.requiredVariables ?? []).includes("service")
      ? { service: DEMO_IDENTITY.service, environment: DEMO_IDENTITY.environment }
      : {};
    for (const drilldown of manifest.drilldownVariables ?? []) {
      variables[drilldown] = "resilience-nonexistent-session";
    }
    const sql = renderQueryTemplate(manifest, variables);
    const lookbackUs = Math.min(manifest.timeRangeCeilingHours, 24) * 3_600_000_000;
    const started = Date.now();
    let status;
    let rows = 0;
    try {
      const result = await search(auth, sql, { startUs: nowUs() - lookbackUs, endUs: nowUs() });
      status = result.status;
      rows = result.hits.length;
    } catch {
      status = 0;
    }
    results.push({
      queryId: manifest.id,
      elapsedMs: Date.now() - started,
      status,
      rows,
      withinOwnTimeoutBudget: Date.now() - started <= manifest.timeoutBudgetMs,
    });
  }
  const elapsedValues = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  return {
    results,
    p95: percentile(elapsedValues, 95),
    allSucceeded: results.every((r) => r.status === 200),
    allWithinOwnBudget: results.every((r) => r.withinOwnTimeoutBudget),
  };
}

// --- 6. notification readiness ---------------------------------------------

async function checkNotificationReadinessHealthy() {
  const result = await runNotificationReadinessProbe();
  return { pass: result.status === NOTIFICATION_READINESS_STATUS.HEALTHY, result };
}

// --- 7. restart recovery matrix ---------------------------------------------

function readStartedAt(service) {
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.StartedAt}}", `chicek-lab-${service}-1`],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

async function captureStateSnapshot() {
  const auth = readAdminAuthHeader();
  const streams = await streamsVerify();
  const dashboards = await dashboardsStatus();
  const alerts = await alertsStatus();
  const pipelines = await listPipelines(auth);
  return {
    streamRumdata: streams.find((s) => s.stream === "_rumdata")?.exists ?? false,
    streamRumlog: streams.find((s) => s.stream === "_rumlog")?.exists ?? false,
    pipelineCount: pipelines.length,
    starterDashboards4: dashboards.starters.filter((s) => s.status.startsWith("INSTALLED")).length,
    starterAlerts: alerts.starters,
  };
}

const SERVICES_LIST = [
  "reverse-proxy",
  "browser-app",
  "http-test-service",
  "alert-sink",
  "openobserve",
];

/**
 * Creates one company-owned (non-starter, no stream-lifecycle/16/17 marker) alert
 * before the restart matrix runs, so the matrix's state-drift checks also
 * cover Section 12's "company-owned disposable dashboard/alert
 * preservation" requirement, not just the starter assets.
 */
async function createDisposableCompanyAlert() {
  const auth = readAdminAuthHeader();
  const policy = loadAllAlertPolicies()[0];
  const query = loadAllQueryManifests().find((q) => q.id === "session-error-rate");
  const body = {
    ...buildOpenObserveAlert(policy, query, {
      owner: "resilience-resilience-gate",
      scope: {
        service: DEMO_IDENTITY.service,
        environment: DEMO_IDENTITY.environment,
        version: DEMO_IDENTITY.version,
      },
      destinationName: LOCAL_DESTINATION_NAME,
      templateName: loadAlertTemplates()[0].openObserveTemplateName,
    }),
    name: `resilience-disposable-company-alert-${Date.now()}`,
    description: "resilience resilience-gate disposable company-owned alert (no starter marker)",
  };
  const response = await createAlert(auth, body);
  if (response.status !== 200) {
    throw new Error(
      `failed to create the disposable company alert for resilience (${response.status})`,
    );
  }
  return response.body.alert_id ?? response.body.id;
}

async function verifyDisposableCompanyAlertPreserved(alertId) {
  const auth = readAdminAuthHeader();
  return Boolean(await getAlert(auth, alertId));
}

async function cleanupDisposableCompanyAlert(alertId) {
  const auth = readAdminAuthHeader();
  await deleteAlert(auth, alertId);
}

async function runRestartScenario(
  target,
  { measureIngest = false, measureQuery = false, measureNotification = false } = {},
) {
  const startedAtBefore = Object.fromEntries(SERVICES_LIST.map((s) => [s, readStartedAt(s)]));
  const before = await captureStateSnapshot();

  const restartIssuedAtMs = Date.now();
  runDockerCompose(["restart", target]);
  const health = await waitForHealthy({ services: [target], timeoutMs: 90_000 });
  const becameHealthyAtMs = Date.now();

  let firstSuccessfulIngestAtMs = null;
  let firstSuccessfulQueryAtMs = null;
  let firstSuccessfulNotificationAtMs = null;

  if (measureIngest) {
    const ingest = await measureIngestionVisibility();
    if (ingest.accepted && ingest.visibilityMs !== null) firstSuccessfulIngestAtMs = Date.now();
  }
  if (measureQuery) {
    const auth = readAdminAuthHeader();
    const result = await search(auth, "select count(*) as c from _rumdata", {
      startUs: (Date.now() - 3_600_000) * 1000,
      endUs: Date.now() * 1000,
    });
    if (result.status === 200) firstSuccessfulQueryAtMs = Date.now();
  }
  if (measureNotification) {
    // alert-sink can still be mid-restart for a few seconds after
    // openobserve's own healthcheck passes (depends_on.restart:true side
    // effect) — wait for it too, or the probe's one-shot "test
    // destination" HTTP call can race a not-yet-listening alert-sink and
    // never be retried.
    await waitForHealthy({ services: ["alert-sink"], timeoutMs: 30_000 });
    const probe = await runNotificationReadinessProbe({ hardTimeoutMs: 30_000 });
    if (probe.status === NOTIFICATION_READINESS_STATUS.HEALTHY)
      firstSuccessfulNotificationAtMs = Date.now();
  }

  const after = await captureStateSnapshot();
  const drift = detectStateDrift(before, after);

  const startedAtAfter = Object.fromEntries(SERVICES_LIST.map((s) => [s, readStartedAt(s)]));
  const restartHappened = Object.fromEntries(
    SERVICES_LIST.map((s) => [s, startedAtAfter[s] !== startedAtBefore[s] ? 1 : 0]),
  );
  const allowedSideEffects = target === "openobserve" ? ["alert-sink"] : [];
  const restartCountCheck = verifyRestartCountExpectation(
    target,
    Object.fromEntries(SERVICES_LIST.map((s) => [s, 0])),
    restartHappened,
    allowedSideEffects,
  );

  const timings = computeRecoveryTimings({
    restartIssuedAtMs,
    becameUnhealthyAtMs: null,
    becameHealthyAtMs,
    firstSuccessfulIngestAtMs,
    firstSuccessfulQueryAtMs,
    firstSuccessfulNotificationAtMs,
  });

  return {
    target,
    healthRecovered: health.healthy,
    timings,
    drift,
    restartCountCheck,
  };
}

async function runRestartRecoveryMatrix() {
  const scenarios = [
    { target: "browser-app", options: {} },
    { target: "http-test-service", options: {} },
    { target: "reverse-proxy", options: { measureIngest: true, measureQuery: true } },
    { target: "alert-sink", options: { measureNotification: true } },
    {
      target: "openobserve",
      options: { measureIngest: true, measureQuery: true, measureNotification: true },
    },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const result = await runRestartScenario(scenario.target, scenario.options);
    results.push(result);
  }
  return results;
}

// --- 8. network partition (docker network disconnect/connect) --------------

async function runNetworkPartitionScenario() {
  const network = "chicek-lab_app-internal";
  const service = "chicek-lab-http-test-service-1";
  // Compose attaches two DNS records per container on a service network:
  // the container name (always restored by a plain `docker network
  // connect`) and the service name alias (`http-test-service`), which Docker does
  // NOT restore on its own — it must be passed explicitly via `--alias`.
  // Without it, other containers (e.g. reverse-proxy) lose the ability to
  // resolve "http-test-service" by hostname even though http-test-service's own health
  // check (which doesn't depend on DNS) keeps reporting healthy.
  const serviceAlias = "http-test-service";
  const disconnectedAtMs = Date.now();
  const disconnect = spawnSync("docker", ["network", "disconnect", network, service]);
  if (disconnect.status !== 0) {
    return { pass: false, reason: `docker network disconnect failed (exit ${disconnect.status})` };
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const reconnect = spawnSync("docker", [
    "network",
    "connect",
    "--alias",
    serviceAlias,
    network,
    service,
  ]);
  const reconnectedAtMs = Date.now();
  if (reconnect.status !== 0) {
    return {
      pass: false,
      reason: `docker network connect failed (exit ${reconnect.status}) — network state may need manual cleanup`,
    };
  }
  const health = await waitForHealthy({ services: ["http-test-service"], timeoutMs: 30_000 });
  const dnsCheck = spawnSync("docker", [
    "exec",
    "chicek-lab-reverse-proxy-1",
    "getent",
    "hosts",
    serviceAlias,
  ]);
  const dnsAliasResolves = dnsCheck.status === 0;
  return {
    pass: health.healthy && dnsAliasResolves,
    unreadyDurationMs: reconnectedAtMs - disconnectedAtMs,
    recoveryTimeMs: Date.now() - reconnectedAtMs,
    dnsAliasResolves,
  };
}

// --- 9. kill switch under load ----------------------------------------------

async function runKillSwitchUnderLoad() {
  const loadPromise = (async () => {
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(await requestProxy(LOGS_PATH, { body: rumPayload() }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return results;
  })();

  await new Promise((resolve) => setTimeout(resolve, 200));
  const onResult = await killSwitchOn({ reason: "operator_request" });
  const blocked = await requestProxy(LOGS_PATH, { body: rumPayload() });
  await loadPromise;
  const offResult = await killSwitchOff();

  const businessApi = await requestProxy("/", { method: "GET", body: undefined });

  return {
    pass:
      onResult.document.killSwitch.active === true &&
      blocked.statusCode === 410 &&
      offResult.document.killSwitch.active === false &&
      businessApi.statusCode === 200,
    blockedStatusCode: blocked.statusCode,
    frontendStatusCode: businessApi.statusCode,
  };
}

// --- 10. container resource recovery ----------------------------------------

export async function measureContainerResourceRecovery() {
  const fdBefore = {};
  for (const service of SERVICES_LIST) fdBefore[service] = sampleFileDescriptorCount(service);

  const before = sampleContainerMetrics();
  // A short, bounded burst against the ingest path only — this gate is
  // "short and deterministic"; the full 3-cycle load/recovery measurement
  // with soak-grade sample counts lives in run-resilience-soak.mjs.
  for (let i = 0; i < 20; i += 1) {
    await requestProxy(LOGS_PATH, { body: rumPayload() });
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const after = sampleContainerMetrics();

  const fdAfter = {};
  for (const service of SERVICES_LIST) fdAfter[service] = sampleFileDescriptorCount(service);

  const perService = {};
  for (const service of SERVICES_LIST) {
    const beforeSample = before[service];
    const afterSample = after[service];
    if (!beforeSample || !afterSample) continue;
    perService[service] = {
      memRatioBefore: computeMemoryLimitRatio(
        beforeSample.memUsageBytes,
        beforeSample.memLimitBytes,
      ),
      memRatioAfter: computeMemoryLimitRatio(afterSample.memUsageBytes, afterSample.memLimitBytes),
      fdDelta:
        fdBefore[service] !== null && fdAfter[service] !== null
          ? computeFdDelta(fdBefore[service], fdAfter[service])
          : null,
    };
  }
  return perService;
}

// --- orchestration -----------------------------------------------------------

export async function verifyResilience() {
  assertExactLabToolchain("test:resilience");
  let overallPass = true;
  const findings = [];
  const measurements = {};

  log("▶ resilience: lib unit coverage suite (parser/collector/budget/recovery/readiness)");
  const coverage = runLibCoverageSuite();
  if (!coverage.pass) {
    overallPass = false;
    findings.push("lib unit coverage suite failed");
    log(coverage.output);
  } else {
    log("  PASS");
  }

  log("▶ resilience: browser budgets (Chromium + Firefox)");
  const browserResults = await measureBrowserBudgets();
  for (const result of browserResults) {
    if (result.consoleErrors.length > 0) {
      overallPass = false;
      findings.push(
        `${result.engine}: host page threw ${result.consoleErrors.length} uncaught error(s)`,
      );
    }
  }
  const allRecordAction = browserResults
    .flatMap((r) => r.durationsMs.recordAction)
    .sort((a, b) => a - b);
  const allRecordError = browserResults
    .flatMap((r) => r.durationsMs.recordError)
    .sort((a, b) => a - b);
  const allSanitizer = browserResults.flatMap((r) => r.durationsMs.sanitizerWorstCase);
  measurements["browser.recordAction.p95"] = percentile(allRecordAction, 95);
  measurements["browser.recordError.p95"] = percentile(allRecordError, 95);
  measurements["browser.sanitizer.max"] = Math.max(...allSanitizer);
  const heapRatios = browserResults
    .filter((r) => r.heapBefore && r.heapAfter)
    .map((r) => r.heapAfter / r.heapBefore);
  measurements["browser.heap.postRecovery"] = heapRatios.length > 0 ? Math.max(...heapRatios) : 1;
  log(`  PASS (recordAction p95=${measurements["browser.recordAction.p95"]?.toFixed(2)}ms)`);

  log("▶ resilience: proxy latency / error distribution");
  const proxy = await measureProxyLatency();
  measurements["proxy.ingest.p95"] = proxy.p95;
  measurements["proxy.unexpected5xx"] = proxy.unexpected5xx;
  log(`  PASS (p95=${proxy.p95}ms, unexpected5xx=${proxy.unexpected5xx})`);

  log("▶ resilience: controlled ingestion visibility canary");
  const ingestion = await measureIngestionVisibility();
  if (!ingestion.accepted || ingestion.visibilityMs === null) {
    overallPass = false;
    findings.push(
      "ingestion visibility canary was never observed as stored within the bounded poll window",
    );
  } else {
    measurements["openobserve.visibility.p95"] = ingestion.visibilityMs;
    log(`  PASS (visibility=${ingestion.visibilityMs}ms)`);
  }

  log("▶ resilience: 30-query catalog performance smoke");
  const queryPerf = await measureQueryCatalogPerformance();
  if (queryPerf.results.length !== 30) {
    overallPass = false;
    findings.push(`expected 30 query manifests, found ${queryPerf.results.length}`);
  }
  if (!queryPerf.allSucceeded) {
    overallPass = false;
    findings.push("at least one query in the 30-query catalog did not return HTTP 200");
  }
  if (!queryPerf.allWithinOwnBudget) {
    overallPass = false;
    findings.push("at least one query exceeded its own manifest timeoutBudgetMs");
  }
  measurements["query.catalog.p95"] = queryPerf.p95;
  log(
    `  ${queryPerf.allSucceeded && queryPerf.allWithinOwnBudget ? "PASS" : "FAIL"} (30/30 ran, p95=${queryPerf.p95}ms)`,
  );

  log("▶ resilience: alert notification readiness (must be HEALTHY, not just container-healthy)");
  const readiness = await checkNotificationReadinessHealthy();
  if (!readiness.pass) {
    overallPass = false;
    findings.push(
      `notification readiness probe was ${readiness.result.status}, not HEALTHY: ${readiness.result.reason}`,
    );
  } else {
    log(
      `  PASS (firing=${readiness.result.firingLatencyMs}ms resolved=${readiness.result.resolvedLatencyMs}ms)`,
    );
  }

  log("▶ resilience: runtime-control-agent restart/preserve check");
  const runtimeControlAgent = await restartRuntimeControlAgentScenario();
  if (!runtimeControlAgent.healthRecovered) {
    overallPass = false;
    findings.push("runtime-control-agent: did not refresh the document after restart");
  }
  if (!runtimeControlAgent.oldPidExited) {
    overallPass = false;
    findings.push("runtime-control-agent: old daemon process was still alive after stop");
  }
  if (!runtimeControlAgent.newPidAlive) {
    overallPass = false;
    findings.push("runtime-control-agent: replacement daemon process was not alive");
  }
  if (!runtimeControlAgent.killSwitchPreservedDuringRefresh) {
    overallPass = false;
    findings.push("runtime-control-agent: kill switch was not preserved across refresh");
  }
  measurements["runtimeControl.agent.readyTime"] = runtimeControlAgent.timings.recoveryTimeMs;
  log(
    `  ${runtimeControlAgent.healthRecovered ? "PASS" : "FAIL"} (recoveryTimeMs=${runtimeControlAgent.timings.recoveryTimeMs}, killSwitchPreserved=${runtimeControlAgent.killSwitchPreservedDuringRefresh})`,
  );

  log("▶ resilience: restart recovery matrix (5 containers)");
  const disposableAlertId = await createDisposableCompanyAlert();
  const restartMatrix = await runRestartRecoveryMatrix();
  const companyAlertPreserved = await verifyDisposableCompanyAlertPreserved(disposableAlertId);
  await cleanupDisposableCompanyAlert(disposableAlertId);
  if (!companyAlertPreserved) {
    overallPass = false;
    findings.push("company-owned disposable alert did not survive the restart matrix (state loss)");
  }
  for (const scenario of restartMatrix) {
    if (!scenario.healthRecovered) {
      overallPass = false;
      findings.push(`${scenario.target}: did not become healthy again after restart`);
    }
    if (scenario.drift.hasDrift) {
      overallPass = false;
      findings.push(
        `${scenario.target}: state drift after restart: ${JSON.stringify(scenario.drift.drifted)}`,
      );
    }
    if (!scenario.restartCountCheck.pass) {
      overallPass = false;
      findings.push(
        `${scenario.target}: unexpected restart side effect(s): ${JSON.stringify(scenario.restartCountCheck.violations)}`,
      );
    }
    log(
      `  ${scenario.target}: recoveryTimeMs=${scenario.timings.recoveryTimeMs} drift=${scenario.drift.hasDrift}`,
    );
  }
  const openobserveScenario = restartMatrix.find((s) => s.target === "openobserve");
  const proxyScenario = restartMatrix.find((s) => s.target === "reverse-proxy");
  const alertSinkScenario = restartMatrix.find((s) => s.target === "alert-sink");
  measurements["restart.openobserve.readyTime"] =
    openobserveScenario?.timings.recoveryTimeMs ?? null;
  measurements["restart.proxy.readyTime"] = proxyScenario?.timings.recoveryTimeMs ?? null;
  measurements["restart.alertSink.readyTime"] = alertSinkScenario?.timings.recoveryTimeMs ?? null;
  measurements["alert.notification.recovery"] =
    openobserveScenario?.timings.notificationRecoveryMs ?? null;

  log("▶ resilience: network partition (docker network disconnect/connect on http-test-service)");
  const partition = await runNetworkPartitionScenario();
  if (!partition.pass) {
    overallPass = false;
    findings.push(
      `network partition scenario failed: ${partition.reason ?? "http-test-service did not recover"}`,
    );
  } else {
    log(`  PASS (recoveryTimeMs=${partition.recoveryTimeMs})`);
  }

  log("▶ resilience: kill switch under load");
  const killSwitch = await runKillSwitchUnderLoad();
  if (!killSwitch.pass) {
    overallPass = false;
    findings.push(`kill-switch-under-load scenario failed: ${JSON.stringify(killSwitch)}`);
  } else {
    log("  PASS");
  }

  log("▶ resilience: container resource recovery");
  const resourceRecovery = await measureContainerResourceRecovery();
  const memRatios = Object.values(resourceRecovery)
    .map((r) => r.memRatioAfter)
    .filter((r) => r !== null);
  measurements["container.memory.peakRatio"] = memRatios.length > 0 ? Math.max(...memRatios) : 0;
  const fdDeltas = Object.values(resourceRecovery)
    .map((r) => r.fdDelta)
    .filter((d) => d !== null);
  measurements["container.fd.postRecoveryDelta"] = fdDeltas.length > 0 ? Math.max(...fdDeltas) : 0;
  log(`  measured (peakMemRatio=${measurements["container.memory.peakRatio"]?.toFixed(3)})`);

  log("▶ resilience: budget evaluation");
  const budgetsFile = loadJson(BUDGETS_PATH);
  const { overallPass: budgetsPass, results: budgetResults } = evaluateAllBudgets(
    budgetsFile.budgets,
    measurements,
  );
  for (const result of budgetResults) {
    if (!result.pass && result.hardOrInformational === "hard") {
      overallPass = false;
      findings.push(`budget ${result.metricId}: ${result.reason}`);
    } else if (!result.pass) {
      log(`  informational budget miss (not gating): ${result.metricId}: ${result.reason}`);
    }
  }
  log(`  ${budgetsPass ? "PASS" : "FAIL"}`);

  if (overallPass) {
    log("\n✔ resilience:resilience PASSED.");
  } else {
    logError("\n✖ resilience:resilience FAILED:");
    for (const finding of findings) logError(`  - ${finding}`);
  }

  return {
    pass: overallPass,
    findings,
    measurements,
    budgetResults,
    runtimeControlAgent,
    restartMatrix,
    readiness: readiness.result,
    queryCatalog: queryPerf,
    ingestion,
    proxy,
    resourceRecovery,
  };
}

function writeResilienceReport(result) {
  const outDir = join(repoRoot, ".runtime/resilience");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `resilience-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "resilience-resilience",
        generatedAt: new Date().toISOString(),
        gitCommit: spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
        }).stdout.trim(),
        ...result,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return outPath;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    const result = await verifyResilience();
    const outPath = writeResilienceReport(result);
    log(`resilience:resilience report written to ${outPath} (gitignored)`);
    const { pass } = result;
    process.exit(pass ? 0 : 1);
  } catch (error) {
    logError(`test:resilience FAILED: ${error.message}\n${error.stack ?? ""}`);
    process.exit(1);
  }
}
