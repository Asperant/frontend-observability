// `pnpm test:stage16:dashboards` — Stage 16 acceptance gate. Combines:
//   1. a coverage-checked vitest run of scripts/lab/dashboards/'s pure logic
//      (100% statements/branches/functions/lines, scoped — see
//      vitest.config.js's "scripts/lab/dashboards/**" threshold entry);
//   2. metric/query catalog manifest validation (shape, SQL safety,
//      cross-references) via the same pure validators the catalog itself
//      must already pass;
//   3. known-fixture metric correctness: direct, deterministic ingest of a
//      small number of records with known counts, verifying every ratio
//      metric's numerator/denominator/guarded-division result exactly;
//   4. empty-data semantics (a real 0 vs. NO_DATA vs. a query error are
//      never conflated);
//   5. starter install idempotency (installs twice in-process);
//   6. company-dashboard preservation / no-overwrite / no-delete / deleted-
//      starter-not-resurrected, across a full install -> company-edit ->
//      delete-a-starter -> reinstall -> restore-starters lifecycle;
//   7. export/backup secret-safety and import's conflict guard;
//   8. live, read-only dashboard-audit risk detection against a disposable,
//      deliberately unsafe dashboard;
//   9. a real Chromium + Firefox schema/query canary, driven through the
//      actual demo app and real @openobserve SDKs, followed by executing
//      the real query catalog against the resulting real telemetry;
//  10. Session Replay / delivery-guarantee absence and management-plane
//      isolation (re-verified live, not assumed);
//  11. the public browser-observability API surface is still unchanged (6
//      exports) — Stage 16 adds no new browser-facing API.
// Never prints a raw secret, credential, or full ingested record.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  caCertPath,
  emailSecretPath,
  log,
  logError,
  passwordSecretPath,
} from "./common.mjs";
import { dashboardsAudit } from "./dashboards-audit.mjs";
import { dashboardsBackup } from "./dashboards-backup.mjs";
import { dashboardsExport } from "./dashboards-export.mjs";
import { dashboardsImport } from "./dashboards-import.mjs";
import { dashboardsInstallStarters } from "./dashboards-install-starters.mjs";
import { dashboardsRestoreStarters } from "./dashboards-restore-starters.mjs";
import { dashboardsStatus } from "./dashboards-status.mjs";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  ingestJson,
  listDashboards,
  listFolders,
  readAdminAuthHeader,
  search,
} from "./dashboards/admin-client.mjs";
import {
  loadAllQueryManifests,
  loadAllStarterDashboards,
  loadMetricCatalog,
} from "./dashboards/catalog.mjs";
import { RISK_CLASS } from "./dashboards/audit.js";
import { validateMetricCatalog } from "./dashboards/metric-catalog.js";
import { parseMarker } from "./dashboards/marker.js";
import { validateQueryManifest } from "./dashboards/query-manifest.js";
import { renderQueryTemplate } from "./dashboards/sql-template.js";
import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";

const DEMO_URL = "https://localhost:8443";
const NOW_US = () => Date.now() * 1000;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function readAdminSecretValues() {
  return [
    readFileSync(emailSecretPath, "utf8").trim(),
    readFileSync(passwordSecretPath, "utf8").trim(),
  ];
}

function assertNoSecretLeak(haystackText, secretValues, label) {
  for (const secret of secretValues) {
    if (secret && haystackText.includes(secret)) {
      throw new Error(`INTERNAL: ${label} contained a raw admin credential.`);
    }
  }
}

async function waitUntil(
  predicate,
  { timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return false;
}

// --- 1. coverage-checked unit suite for scripts/lab/dashboards/ ----------

function runDashboardsUnitCoverage() {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "lab",
      "tests/lab/dashboards",
      "--coverage",
      "--coverage.include=scripts/lab/dashboards/**/*.js",
    ],
    { encoding: "utf8" },
  );
  return {
    pass: result.status === 0,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-4000),
  };
}

// --- 2. metric/query catalog manifest validation --------------------------

function verifyCatalogValidation() {
  const findings = [];
  const queryManifests = loadAllQueryManifests();
  if (queryManifests.length !== 26) {
    findings.push(
      `query catalog size changed: expected 26 manifests, got ${queryManifests.length}.`,
    );
  }
  for (const manifest of queryManifests) {
    const result = validateQueryManifest(manifest);
    if (!result.valid) {
      findings.push(`query manifest '${manifest.id}' invalid: ${result.errors.join("; ")}`);
    }
  }
  const metricCatalog = loadMetricCatalog();
  if (metricCatalog.metrics?.length !== 12) {
    findings.push(
      `metric catalog size changed: expected 12 metrics, got ${metricCatalog.metrics?.length ?? "missing"}.`,
    );
  }
  const knownQueryIds = new Set(queryManifests.map((manifest) => manifest.id));
  const metricResult = validateMetricCatalog(metricCatalog, knownQueryIds);
  if (!metricResult.valid) {
    findings.push(`metric catalog invalid: ${metricResult.errors.join("; ")}`);
  }
  const starters = loadAllStarterDashboards();
  const queryIds = new Set(queryManifests.map((manifest) => manifest.id));
  for (const starter of starters) {
    for (const tab of starter.tabs) {
      for (const panel of tab.panels) {
        if (!queryIds.has(panel.queryRef)) {
          findings.push(
            `starter '${starter.starterId}' panel '${panel.id}' references unknown queryRef '${panel.queryRef}'`,
          );
        }
      }
    }
  }
  return findings;
}

// --- 3/4. known-fixture metric correctness + empty-data semantics --------

async function verifyFixtureMetricsAndEmptyData(auth, runId) {
  const findings = [];
  const fixtureService = `stage16-fixture-${runId}`;
  const env = "lab";
  const nowUs = NOW_US();

  const records = [
    { type: "view", session_id: "fixture-s1", service: fixtureService, env, _timestamp: nowUs },
    { type: "view", session_id: "fixture-s2", service: fixtureService, env, _timestamp: nowUs },
    { type: "view", session_id: "fixture-s3", service: fixtureService, env, _timestamp: nowUs },
    { type: "view", session_id: "fixture-s4", service: fixtureService, env, _timestamp: nowUs },
    {
      type: "error",
      session_id: "fixture-s1",
      service: fixtureService,
      env,
      error_type: "fixture",
      _timestamp: nowUs,
    },
    {
      type: "error",
      session_id: "fixture-s2",
      service: fixtureService,
      env,
      error_type: "fixture",
      _timestamp: nowUs,
    },
    {
      type: "resource",
      session_id: "fixture-s1",
      service: fixtureService,
      env,
      resource_status_code: 200,
      resource_type: "fetch",
      _timestamp: nowUs,
    },
    {
      type: "resource",
      session_id: "fixture-s2",
      service: fixtureService,
      env,
      resource_status_code: 500,
      resource_type: "fetch",
      _timestamp: nowUs,
    },
  ];
  const ingest = await ingestJson(auth, "_rumdata", records);
  if (!ingest.ok) {
    findings.push(`fixture ingest into _rumdata failed (status ${ingest.status}).`);
    return findings;
  }

  const win = { startUs: nowUs - 5_000_000, endUs: NOW_US() };
  const queryManifests = new Map(
    loadAllQueryManifests().map((manifest) => [manifest.id, manifest]),
  );
  const vars = { service: fixtureService, environment: env };

  const found = await waitUntil(async () => {
    const sql = renderQueryTemplate(queryManifests.get("sessions-count"), vars);
    const result = await search(auth, sql, win);
    return result.status === 200 && result.hits[0]?.sessions === 4;
  });
  if (!found) {
    findings.push("fixture: sessions-count did not converge to the expected value 4.");
    return findings;
  }

  async function assertQuery(id, expected) {
    const sql = renderQueryTemplate(queryManifests.get(id), vars);
    const result = await search(auth, sql, win);
    if (result.status !== 200) {
      findings.push(`fixture query '${id}' failed (status ${result.status}).`);
      return;
    }
    const row = result.hits[0] ?? {};
    for (const [column, expectedValue] of Object.entries(expected)) {
      if (row[column] !== expectedValue) {
        findings.push(
          `fixture query '${id}' column '${column}' = ${JSON.stringify(row[column])}, expected ${JSON.stringify(expectedValue)}.`,
        );
      }
    }
  }

  await assertQuery("sessions-count", { sessions: 4 });
  await assertQuery("views-count", { views: 4 });
  await assertQuery("session-error-rate", {
    sessions: 4,
    sessions_with_error: 2,
    session_error_rate: 0.5,
  });
  await assertQuery("errors-per-1000-views", { errors: 2, views: 4, errors_per_1000_views: 500 });
  await assertQuery("resource-failure-rate", {
    failed_resources: 1,
    resources: 2,
    resource_failure_rate: 0.5,
  });

  // empty-data: a service with zero matching records.
  const emptyVars = { service: `${fixtureService}-nonexistent`, environment: env };
  const emptySessionsSql = renderQueryTemplate(queryManifests.get("sessions-count"), emptyVars);
  const emptySessions = await search(auth, emptySessionsSql, win);
  if (emptySessions.status !== 200 || emptySessions.hits[0]?.sessions !== 0) {
    findings.push("empty-data: sessions-count for a nonexistent service did not return a real 0.");
  }
  const emptyRateSql = renderQueryTemplate(queryManifests.get("session-error-rate"), emptyVars);
  const emptyRate = await search(auth, emptyRateSql, win);
  if (
    emptyRate.status !== 200 ||
    emptyRate.hits[0]?.session_error_rate != null ||
    emptyRate.hits[0]?.sessions !== 0
  ) {
    findings.push(
      "empty-data: session-error-rate for a nonexistent service did not return NO_DATA (null/omitted rate).",
    );
  }
  const badSql = await search(auth, "select * fromm _rumdata limit 1", win);
  if (badSql.status === 200) {
    findings.push("empty-data: a syntactically invalid query unexpectedly returned status 200.");
  }

  return findings;
}

// --- 5/6. install idempotency + company dashboard preservation lifecycle --

async function verifyInstallLifecycle(auth) {
  const findings = [];

  const first = await dashboardsInstallStarters();
  const second = await dashboardsInstallStarters();
  for (const result of second) {
    if (result.outcome !== "NO_CHANGE_ALREADY_INSTALLED") {
      findings.push(
        `second install run for '${result.starterId}' was not NO_CHANGE (${result.outcome}).`,
      );
    }
  }
  if (
    first.some(
      (result) =>
        result.outcome === "CREATE_FAILED" || result.outcome === "CREATED_BUT_READBACK_MISMATCH",
    )
  ) {
    findings.push("first install run reported a failure for a starter dashboard.");
  }

  const folders = await listFolders(auth);
  const starterFolder = folders.find((folder) => folder.name === "CHICEK Starters");
  if (!starterFolder) {
    findings.push("'CHICEK Starters' folder missing after install.");
    return findings;
  }

  // Company creates its own dashboard.
  const companyTitle = `Stage16 Company Dashboard`;
  const companyCreate = await createDashboard(auth, starterFolder.folderId, {
    version: 3,
    dashboardId: "",
    title: companyTitle,
    description: "created by the company via the UI, no marker",
    role: "",
    owner: "company-user@example.com",
    created: new Date().toISOString(),
    tabs: [{ tabId: "default", name: "Default", panels: [] }],
    variables: { list: [] },
  });
  if (companyCreate.status !== 200) {
    findings.push("failed to create the disposable company dashboard for the lifecycle test.");
    return findings;
  }
  const companyDashboardId = companyCreate.body.v3.dashboardId;

  // Company deletes one starter dashboard.
  const dashboardsBefore = await listDashboards(auth, starterFolder.folderId);
  const targetStarter = dashboardsBefore.find(
    (dashboard) => parseMarker(dashboard.description)?.starterId === "frontend-operations",
  );
  if (!targetStarter) {
    findings.push(
      "could not find the 'frontend-operations' starter dashboard to delete for the lifecycle test.",
    );
  } else {
    const deletion = await deleteDashboard(
      auth,
      targetStarter.dashboard_id,
      starterFolder.folderId,
    );
    if (!deletion.ok)
      findings.push(
        "failed to delete the 'frontend-operations' starter dashboard for the lifecycle test.",
      );

    const afterDeleteInstall = await dashboardsInstallStarters();
    const frontendOpsResult = afterDeleteInstall.find(
      (result) => result.starterId === "frontend-operations",
    );
    if (frontendOpsResult?.outcome !== "SKIP_PREVIOUSLY_DELETED_BY_COMPANY") {
      findings.push(
        `normal install-starters did not respect the company deletion of 'frontend-operations' (outcome: ${frontendOpsResult?.outcome}).`,
      );
    }
    const statusAfterSkip = await dashboardsStatus();
    if (
      statusAfterSkip.starters.find((s) => s.starterId === "frontend-operations")?.status ===
      "INSTALLED_CURRENT"
    ) {
      findings.push(
        "'frontend-operations' was unexpectedly recreated by a normal install run after deletion.",
      );
    }

    const restore = await dashboardsRestoreStarters({ confirmed: true });
    if (!restore.allowed || restore.results.some((r) => r.outcome !== "RESTORED")) {
      findings.push(
        "restore-starters --confirm did not successfully restore the deleted starter dashboard.",
      );
    }
  }

  // The company dashboard must have survived the entire delete/reinstall/restore cycle untouched.
  const companyReadBack = await getDashboard(auth, companyDashboardId, starterFolder.folderId);
  if (!companyReadBack || companyReadBack.v3.title !== companyTitle) {
    findings.push(
      "company-created dashboard did not survive the starter delete/reinstall/restore lifecycle.",
    );
  }

  // Cleanup: remove the disposable company dashboard this test created.
  await deleteDashboard(auth, companyDashboardId, starterFolder.folderId);

  return findings;
}

// --- 7. export/backup secret-safety + import conflict guard ---------------

async function verifyExportBackupImport(secretValues) {
  const findings = [];

  const exportResult = await dashboardsExport();
  const exportText = readdirSync(exportResult.outDir)
    .map((name) => readFileSync(join(exportResult.outDir, name), "utf8"))
    .join("\n");
  assertNoSecretLeak(exportText, secretValues, "dashboards-export output");
  if (
    exportText.includes("dashboardId") ||
    exportText.includes('"hash"') ||
    exportText.includes('"owner"')
  ) {
    findings.push("dashboards-export output unexpectedly contains a server-only/volatile field.");
  }

  const backupResult = await dashboardsBackup();
  const backupText = readdirSync(backupResult.outDir)
    .map((name) => readFileSync(join(backupResult.outDir, name), "utf8"))
    .join("\n");
  assertNoSecretLeak(backupText, secretValues, "dashboards-backup output");

  // Import conflict guard: dry-run against the export of an already-installed
  // starter must report SKIP_EXISTING_TITLE under the default skip policy.
  const dryRun = await dashboardsImport({
    dir: exportResult.outDir,
    folderName: "CHICEK Starters",
    conflictPolicy: "skip",
    apply: false,
  });
  if (!dryRun.results.every((result) => result.plannedAction === "SKIP_EXISTING_TITLE")) {
    findings.push(
      "import dry-run against an export of already-installed starters did not plan to skip every title.",
    );
  }

  return findings;
}

// --- 8. live dashboard-audit risk detection --------------------------------

async function verifyLiveAuditDetectsRisk(auth) {
  const findings = [];
  const folders = await listFolders(auth);
  const starterFolder = folders.find((folder) => folder.name === "CHICEK Starters");
  if (!starterFolder) {
    findings.push("'CHICEK Starters' folder missing for the audit-detection test.");
    return findings;
  }

  const unsafeDashboard = {
    version: 3,
    dashboardId: "",
    title: "Stage16 Disposable Unsafe Probe",
    description: "disposable audit probe",
    role: "",
    owner: "audit-probe@example.com",
    created: new Date().toISOString(),
    tabs: [
      {
        tabId: "default",
        name: "Default",
        panels: [
          {
            id: "unsafe-panel",
            type: "table",
            title: "Unsafe",
            description: "",
            config: { show_legends: true },
            queryType: "sql",
            queries: [
              {
                query: "select * from _rumdata where env = 'lab'",
                customQuery: true,
                fields: {
                  stream: "_rumdata",
                  stream_type: "logs",
                  x: [],
                  y: [],
                  z: [],
                  filter: [],
                },
                config: { promql_legend: "" },
              },
            ],
            layout: { x: 0, y: 0, w: 12, h: 8, i: 1 },
          },
        ],
      },
    ],
    variables: { list: [] },
  };
  const created = await createDashboard(auth, starterFolder.folderId, unsafeDashboard);
  if (created.status !== 200) {
    findings.push("failed to create the disposable unsafe dashboard for the audit-detection test.");
    return findings;
  }
  const dashboardId = created.body.v3.dashboardId;

  const reports = await dashboardsAudit();
  const report = reports.find((r) => r.dashboardId === dashboardId);
  if (!report || report.overall === RISK_CLASS.PASS) {
    findings.push("dashboards-audit did not flag the deliberately unsafe disposable dashboard.");
  }

  const deletion = await deleteDashboard(auth, dashboardId, starterFolder.folderId);
  if (!deletion.ok)
    findings.push(
      "failed to delete the disposable unsafe dashboard after the audit-detection test.",
    );
  const afterDelete = await getDashboard(auth, dashboardId, starterFolder.folderId);
  if (afterDelete !== null)
    findings.push("disposable unsafe dashboard still exists after deletion.");

  return findings;
}

// --- 10. management-plane isolation ----------------------------------------

function httpsGetStatus(url, authHeader) {
  const ca = readFileSync(caCertPath, "utf8");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: "GET", ca, headers: { Authorization: authHeader } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function verifyManagementIsolation(auth) {
  const findings = [];
  const paths = ["/api/default/dashboards", "/api/v2/default/folders/dashboards"];
  for (const path of paths) {
    const status = await httpsGetStatus(`${DEMO_URL}${path}`, auth).catch(() => 0);
    if (status < 400) {
      findings.push(
        `Management path ${path} was unexpectedly reachable via the browser-facing proxy (status ${status}).`,
      );
    }
  }
  return findings;
}

// --- 11. public API still 6 -------------------------------------------------

async function verifyPublicApiUnchanged() {
  const findings = [];
  const modUrl = new URL("../../packages/browser-observability/src/index.js", import.meta.url);
  const mod = await import(modUrl.href);
  const expected = [
    "getObservabilityStatus",
    "initializeObservability",
    "recordAction",
    "recordError",
    "setTrackingConsent",
    "shutdownObservability",
  ].sort();
  const actual = Object.keys(mod).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    findings.push(
      `public API surface changed: expected [${expected.join(", ")}], got [${actual.join(", ")}].`,
    );
  }
  return findings;
}

// --- 9. real Chromium/Firefox query canary ----------------------------------

const BROWSER_SHORT_CODE = Object.freeze({ chromium: "cr", firefox: "ff" });
const SQL_LITERAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

function generateBrowserSafeRunId(browserLabel) {
  const shortCode = BROWSER_SHORT_CODE[browserLabel] ?? browserLabel.slice(0, 2);
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `st16-${shortCode}-${timePart}-${randomPart}`;
}

function escapeSqlLiteral(value) {
  if (typeof value !== "string" || !SQL_LITERAL_PATTERN.test(value)) {
    throw new Error(`unsafe Stage 16 canary SQL literal: ${JSON.stringify(value)}`);
  }
  return value.replaceAll("'", "''");
}

async function driveCanaryBrowser(browserType, testRunId) {
  const browser = await browserType.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript((runId) => {
      globalThis.__CHICEK_TEST_RUN_ID__ = runId;
    }, testRunId);
    const page = await context.newPage();
    await page.goto(DEMO_URL);
    await page.waitForTimeout(300);

    async function click(id) {
      await page.getByTestId(`scenario-${id}`).click();
      await page.waitForTimeout(250);
    }

    await click("initialize-runtime-config");
    await click("consent-grant");
    await click("record-action");
    await click("runtime-error");
    await page.waitForTimeout(200);
    await click("success-request");
    await click("server-error");
    await click("long-task");
    // Same real, independently-measured ~35s native SDK batch-flush behavior
    // established in scripts/lab/verify-stage15-streams.mjs — see that
    // file's comment for the full rationale. This gate reuses the identical
    // wait rather than re-deriving it.
    await page.waitForTimeout(36_000);
  } finally {
    await browser.close();
  }
}

async function pollSearch(auth, sql, startUs, { expectHits = true } = {}) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let latest;
  do {
    latest = await search(auth, sql, { startUs, endUs: NOW_US() });
    if (latest.status === 200 && (!expectHits || latest.hits.length > 0)) return latest;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  return latest;
}

async function findCurrentRunSessionId(auth, testRunId, startUs) {
  const result = await pollSearch(
    auth,
    `select session_id from _rumdata where test_run_id = '${escapeSqlLiteral(testRunId)}' and session_id is not null limit 1`,
    startUs,
  );
  return result.status === 200 ? result.hits[0]?.session_id : undefined;
}

async function verifyAllQueryManifestsExecute(auth, queryManifests, variables, win, browserLabel) {
  const findings = [];
  let executed = 0;
  for (const manifest of queryManifests.values()) {
    let sql;
    try {
      sql = renderQueryTemplate(manifest, variables);
    } catch (error) {
      findings.push(`[${browserLabel}] query '${manifest.id}' failed to render: ${error.message}.`);
      continue;
    }
    const result = await search(auth, sql, win);
    if (result.status !== 200) {
      findings.push(
        `[${browserLabel}] query '${manifest.id}' failed live _search (status ${result.status}).`,
      );
      continue;
    }
    executed += 1;
  }
  if (executed !== 26) {
    findings.push(`[${browserLabel}] live _search executed ${executed}/26 query manifests.`);
  }
  return findings;
}

async function runBrowserQueryCanary(browserLabel, browserType, auth) {
  const findings = [];
  const testRunId = generateBrowserSafeRunId(browserLabel);
  const startedUs = NOW_US() - 5_000_000;

  await driveCanaryBrowser(browserType, testRunId);

  const win = { startUs: startedUs, endUs: NOW_US() };
  const queryManifests = new Map(
    loadAllQueryManifests().map((manifest) => [manifest.id, manifest]),
  );
  const vars = { service: DEMO_IDENTITY.service, environment: DEMO_IDENTITY.environment };

  const sessionsFound = await waitUntil(async () => {
    const sql = renderQueryTemplate(queryManifests.get("sessions-count"), vars);
    const result = await search(auth, sql, win);
    return result.status === 200 && result.hits[0]?.sessions > 0;
  });
  if (!sessionsFound)
    findings.push(`[${browserLabel}] sessions-count query found no real sessions.`);

  const sessionId = await findCurrentRunSessionId(auth, testRunId, startedUs);
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    findings.push(
      `[${browserLabel}] could not find a real session_id for query-catalog drilldowns.`,
    );
  } else {
    findings.push(
      ...(await verifyAllQueryManifestsExecute(
        auth,
        queryManifests,
        { ...vars, version: DEMO_IDENTITY.version, session_id: sessionId },
        win,
        browserLabel,
      )),
    );
  }

  async function assertPositive(id, column) {
    const sql = renderQueryTemplate(queryManifests.get(id), vars);
    const result = await pollSearch(auth, sql, startedUs);
    const value = result.hits[0]?.[column];
    if (typeof value !== "number" || value <= 0) {
      findings.push(
        `[${browserLabel}] query '${id}' column '${column}' was not a real positive number (got ${JSON.stringify(value)}).`,
      );
    }
  }

  await assertPositive("views-count", "views");
  await assertPositive("resource-failure-breakdown", "resources");
  await assertPositive("browser-log-counts-by-level", "log_count");

  const errorTrendSql = renderQueryTemplate(queryManifests.get("error-trend"), vars);
  const errorTrend = await pollSearch(auth, errorTrendSql, startedUs);
  if (errorTrend.status !== 200) findings.push(`[${browserLabel}] error-trend query failed.`);

  // Replay must never be recorded (Stage 11, still Security Blocked).
  const replay = await search(auth, "select * from _rumreplay limit 1", {
    startUs: startedUs,
    endUs: NOW_US(),
  });
  if (replay.status === 200 && replay.hits.length > 0) {
    findings.push(
      `[${browserLabel}] session replay data was found — replay must never be recorded.`,
    );
  }

  return findings;
}

// --- orchestration -----------------------------------------------------------

export async function verifyStage16Dashboards() {
  const findings = [];
  const secretValues = readAdminSecretValues();
  const auth = readAdminAuthHeader();

  log(
    "test:stage16:dashboards — running coverage-checked unit suite for scripts/lab/dashboards/...",
  );
  const unit = runDashboardsUnitCoverage();
  if (!unit.pass) {
    findings.push("scripts/lab/dashboards/ unit+coverage suite failed.");
    return { pass: false, findings };
  }

  log("test:stage16:dashboards — metric/query catalog validation...");
  findings.push(...verifyCatalogValidation());

  log("test:stage16:dashboards — known-fixture metric correctness + empty-data semantics...");
  const fixtureRunId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  findings.push(...(await verifyFixtureMetricsAndEmptyData(auth, fixtureRunId)));

  log(
    "test:stage16:dashboards — starter install lifecycle (idempotency, company preservation, deletion respected, restore)...",
  );
  findings.push(...(await verifyInstallLifecycle(auth)));

  log("test:stage16:dashboards — export/backup secret-safety + import conflict guard...");
  findings.push(...(await verifyExportBackupImport(secretValues)));

  log("test:stage16:dashboards — live dashboard-audit risk detection...");
  findings.push(...(await verifyLiveAuditDetectsRisk(auth)));

  log("test:stage16:dashboards — management-plane isolation...");
  findings.push(...(await verifyManagementIsolation(auth)));

  log("test:stage16:dashboards — public API surface unchanged...");
  findings.push(...(await verifyPublicApiUnchanged()));

  log("test:stage16:dashboards — Chromium real query canary...");
  findings.push(...(await runBrowserQueryCanary("chromium", chromium, auth)));

  log("test:stage16:dashboards — Firefox real query canary...");
  findings.push(...(await runBrowserQueryCanary("firefox", firefox, auth)));

  assertNoSecretLeak(JSON.stringify(findings), secretValues, "a Stage 16 finding string");
  return { pass: findings.length === 0, findings };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:stage16:dashboards");
    const result = await verifyStage16Dashboards();
    if (result.pass) {
      log("\n✔ Stage 16 dashboard/query governance verification PASSED.");
    } else {
      logError("\n✖ Stage 16 dashboard/query governance verification FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:stage16:dashboards FAILED: ${error.message}`);
    process.exit(1);
  }
}
