import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { chromium, firefox } from "@playwright/test";

import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";
import {
  assertExactLabToolchain,
  caCertPath,
  emailSecretPath,
  log,
  logError,
  runDockerCompose,
} from "./common.mjs";
import { alertsAudit } from "./alerts-audit.mjs";
import { alertsBackup } from "./alerts-backup.mjs";
import { alertsExport } from "./alerts-export.mjs";
import { LOCAL_DESTINATION_NAME, alertsInstallStarters } from "./alerts-install-starters.mjs";
import { alertsRestoreStarters } from "./alerts-restore-starters.mjs";
import { alertsStatus } from "./alerts-status.mjs";
import { alertsTestNotification } from "./alerts-test-notification.mjs";
import {
  createAlert,
  deleteAlert,
  getAlert,
  listAlerts,
  readAdminAuthHeader,
} from "./alerts/admin-client.mjs";
import { buildOpenObserveAlert } from "./alerts/alert-builder.js";
import { loadAllAlertPolicies, loadAlertTemplates } from "./alerts/catalog.mjs";
import { parseMarker } from "./alerts/marker.js";
import { loadAllQueryManifests } from "./dashboards/catalog.mjs";

function runCoverage() {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "lab",
      "tests/lab/alerts",
      "apps/mock-api/tests/server.test.js",
      "--coverage",
      "--coverage.include=scripts/lab/alerts/**/*.js",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `alert pure coverage failed:\n${`${result.stdout}\n${result.stderr}`.slice(-4000)}`,
    );
  }
}

async function runBrowserCanary(browserType) {
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "x-stage17-alert-canary": browserType.name() },
  });
  const page = await context.newPage();
  await page.goto("https://localhost:8443", { waitUntil: "networkidle" });
  await page.getByTestId("status-panel").waitFor({ timeout: 20_000 });
  await browser.close();
}

function companyAlertBody(owner, queryManifest) {
  const policy = loadAllAlertPolicies()[0];
  return {
    ...buildOpenObserveAlert(policy, queryManifest, {
      owner,
      scope: {
        service: DEMO_IDENTITY.service,
        environment: DEMO_IDENTITY.environment,
        version: DEMO_IDENTITY.version,
      },
      destinationName: LOCAL_DESTINATION_NAME,
      templateName: loadAlertTemplates()[0].openObserveTemplateName,
    }),
    name: `stage17-company-alert-${Date.now()}`,
    description: "company-managed alert without starter marker",
  };
}

async function verifyOwnershipLifecycle() {
  const auth = readAdminAuthHeader();
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const expectedStarterCount = loadAllAlertPolicies().length;
  const queries = new Map(loadAllQueryManifests().map((query) => [query.id, query]));
  const company = await createAlert(
    auth,
    companyAlertBody(owner, queries.get("session-error-rate")),
  );
  if (company.status !== 200) throw new Error(`company alert create failed (${company.status})`);
  const companyId = company.body.alert_id ?? company.body.id;

  const starter = (await listAlerts(auth)).find((alert) => parseMarker(alert.description));
  if (!starter) throw new Error("no starter alert found after install");
  await deleteAlert(auth, starter.alert_id ?? starter.id);
  const afterDeleteCount = (await listAlerts(auth)).length;
  await alertsInstallStarters();
  const afterReinstall = await listAlerts(auth);
  if (afterReinstall.length !== afterDeleteCount) {
    throw new Error("normal install recreated a deleted starter or created a duplicate");
  }
  if (!(await getAlert(auth, companyId))) throw new Error("company alert was not preserved");
  await deleteAlert(auth, companyId);
  const restored = await alertsRestoreStarters({ confirmed: true });
  if (!restored.allowed) throw new Error("confirmed starter restore was refused");
  const restoredStatus = await alertsStatus();
  if (restoredStatus.starters !== expectedStarterCount) {
    throw new Error(
      `confirmed starter restore left ${restoredStatus.starters} starters, expected ${expectedStarterCount}`,
    );
  }
}

async function verifyManagementIsolation() {
  const status = await new Promise((resolve, reject) => {
    const req = httpsRequest(
      "https://localhost:8443/alerts",
      { ca: readFileSync(caCertPath), headers: { accept: "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  if (status < 400) throw new Error("public reverse proxy exposed an alert management path");
}

export async function verifyStage17Alerts() {
  assertExactLabToolchain("test:stage17:alerts");
  log("test:stage17:alerts");
  log("  coverage and manifest validation...");
  runCoverage();
  log("  installing starters twice...");
  await alertsInstallStarters();
  await alertsInstallStarters();
  const status = await alertsStatus();
  const expectedStarterCount = loadAllAlertPolicies().length;
  if (status.starters !== expectedStarterCount) {
    throw new Error(`expected ${expectedStarterCount} starter alerts, got ${status.starters}`);
  }
  log("  ownership lifecycle...");
  await verifyOwnershipLifecycle();
  log("  read-only audit/export/backup...");
  await alertsAudit();
  await alertsExport();
  await alertsBackup();
  log("  local notification sink...");
  runDockerCompose(["up", "-d", "--force-recreate", "alert-sink"]);
  const notification = await alertsTestNotification();
  if (!notification.firingOk || !notification.resolvedOk || !notification.failureVisible) {
    throw new Error("local notification lifecycle failed");
  }
  log("  Chromium and Firefox canary...");
  await runBrowserCanary(chromium);
  await runBrowserCanary(firefox);
  log("  management API isolation...");
  await verifyManagementIsolation();
  return { status, notification };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    await verifyStage17Alerts();
    log("test:stage17:alerts PASSED");
  } catch (error) {
    logError(`test:stage17:alerts FAILED: ${error.message}`);
    process.exit(1);
  }
}
