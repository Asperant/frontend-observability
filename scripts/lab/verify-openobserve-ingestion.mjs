import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { chromium } from "@playwright/test";

import {
  assertExactLabToolchain,
  caCertPath,
  emailSecretPath,
  log,
  logError,
  passwordSecretPath,
  runtimeConfigPath,
} from "./common.mjs";
import { DEMO_IDENTITY } from "../../tests/fixtures/apps/browser-app/src/identity.js";
import { RUM_APPLICATION_ID } from "./generate-runtime-config.mjs";

const DEMO_URL = "https://localhost:8443";
const PROXY_URL = "https://localhost:8443";
const OPENOBSERVE_ADMIN_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";
const NOW_US = () => Date.now() * 1000;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

// Admin credentials live only in this process's memory for the lifetime of
// this script; they are read once, used to call the OpenObserve API
// directly (never through the public reverse-proxy, which denies /api/),
// and never written to a file, logged, or passed to the browser.
function readAdminCredentials() {
  return {
    email: readFileSync(emailSecretPath, "utf8").trim(),
    password: readFileSync(passwordSecretPath, "utf8").trim(),
  };
}

function basicAuthHeader(email, password) {
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

async function adminSearch(auth, sql, { startUs = NOW_US() - 60 * 60 * 1_000_000 } = {}) {
  const response = await fetch(`${OPENOBSERVE_ADMIN_URL}/api/${ORG_ID}/_search?type=logs`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { sql, start_time: startUs, end_time: NOW_US() } }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, hits: body.hits ?? [], body };
}

async function pollSearch(auth, sql, { startUs, expectHits = true } = {}) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let latest;
  do {
    latest = await adminSearch(auth, sql, { startUs });
    if (latest.status === 200 && expectHits && latest.hits.length > 0) return latest;
    if (latest.status === 200 && !expectHits && latest.hits.length === 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  return latest ?? { status: 0, hits: [], body: null };
}

function escapeSqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function intakeUrl(stream) {
  return `${PROXY_URL}/rum/v1/default/${stream}`;
}

function postHttpsText(url, body) {
  const ca = readFileSync(caCertPath, "utf8");
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        ca,
        headers: {
          Host: "localhost:8443",
          Origin: "https://localhost:8443",
          "Content-Type": "text/plain;charset=UTF-8",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function sendIntake(stream, events) {
  const requestId = crypto.randomUUID();
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  const response = await postHttpsText(intakeUrl(stream), body);
  return { requestId, ...response };
}

function createRumCanaries(testRunId) {
  const sessionId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  const base = {
    date: Date.now(),
    test_run_id: testRunId,
    application_id: RUM_APPLICATION_ID,
    service: DEMO_IDENTITY.service,
    env: DEMO_IDENTITY.environment,
    version: DEMO_IDENTITY.version,
    session_id: sessionId,
    view_id: viewId,
    session: { id: sessionId },
    view: {
      id: viewId,
      url: "https://localhost:8443/openobserve-regression",
    },
  };
  return [
    { ...base, type: "view" },
    {
      ...base,
      type: "resource",
      resource: {
        id: crypto.randomUUID(),
        type: "fetch",
        method: "GET",
        status_code: 200,
        url: "https://localhost:8443/api/status/200",
      },
    },
    {
      ...base,
      type: "action",
      action_id: crypto.randomUUID(),
      action: {
        id: crypto.randomUUID(),
        type: "custom",
        target: { name: "openobserve.regression-action" },
      },
    },
    {
      ...base,
      type: "error",
      error_id: crypto.randomUUID(),
      error: {
        id: crypto.randomUUID(),
        source: "source",
        source_type: "browser",
        type: "Error",
        message: "OpenObserve regression error canary",
      },
    },
  ];
}

function createLogCanary(testRunId) {
  return {
    date: Date.now(),
    test_run_id: testRunId,
    message: "openobserve.regression-log",
    status: "info",
    origin: "logger",
    application_id: RUM_APPLICATION_ID,
    service: DEMO_IDENTITY.service,
    env: DEMO_IDENTITY.environment,
    version: DEMO_IDENTITY.version,
  };
}

async function driveDemoBrowser() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(DEMO_URL);
    await page.waitForTimeout(300);

    async function click(id) {
      await page.getByTestId(`scenario-${id}`).click();
      await page.waitForTimeout(250);
    }

    // Consent-before-telemetry: initialize, capture status, then grant
    // consent (this also fires the browser-log canary — see
    // create-adapter.js's first-grant-only canary log).
    await click("initialize-runtime-config");
    const statusBeforeConsent = await page.getByTestId("status-panel").innerText();
    await click("consent-grant");

    await click("record-action");
    await click("runtime-error");
    await page.waitForTimeout(200);
    await click("unhandled-rejection");
    await page.waitForTimeout(200);
    await click("success-request");
    await click("server-error");
    await click("long-task");
    await page.waitForTimeout(800);

    const statusAfterConsent = await page.getByTestId("status-panel").innerText();

    await click("shutdown");
    const statusAfterShutdown = await page.getByTestId("status-panel").innerText();

    // Reinitialize against the *real* runtime config (not the "reinitialize"
    // button, which intentionally points at a disabled fixture for an
    // unrelated runtime-config test) so this exercises the real SDK's
    // shutdown -> reinitialize -> second-event lifecycle end to end.
    await click("initialize-runtime-config");
    await page.waitForTimeout(400);
    const statusAfterReinit = await page.getByTestId("status-panel").innerText();
    await click("record-action");
    await page.waitForTimeout(300);
    const statusAfterSecondEvent = await page.getByTestId("status-panel").innerText();

    return {
      statusBeforeConsent,
      statusAfterConsent,
      statusAfterShutdown,
      statusAfterReinit,
      statusAfterSecondEvent,
    };
  } finally {
    await browser.close();
  }
}

export async function verifyOpenObserveIngestion() {
  const findings = [];
  const { email, password } = readAdminCredentials();
  const auth = basicAuthHeader(email, password);
  const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
  const rumToken = runtimeConfig.rum?.clientToken;
  const testRunId = `openobserve-regression-${crypto.randomUUID()}`;
  const startedUs = NOW_US() - 5_000_000;

  if (typeof rumToken !== "string" || rumToken.length < 16) {
    findings.push("Generated runtime config has no usable rum.clientToken.");
    return { pass: false, findings };
  }

  log("verify:openobserve:ingestion — driving the demo through a real browser...");
  const statuses = await driveDemoBrowser();

  if (!/state\s*active/.test(statuses.statusAfterConsent.replace(/\n/g, " "))) {
    findings.push(
      `Demo did not reach an active state after consent: ${statuses.statusAfterConsent}`,
    );
  }
  if (!/shutdown/i.test(statuses.statusAfterShutdown)) {
    findings.push(`Demo did not report shutdown after shutdown: ${statuses.statusAfterShutdown}`);
  }
  if (!/state\s*active/.test(statuses.statusAfterReinit.replace(/\n/g, " "))) {
    findings.push(
      `Demo did not reach an active state after reinitialize: ${statuses.statusAfterReinit}`,
    );
  }
  if (!/acceptedActions\s*[1-9]/.test(statuses.statusAfterSecondEvent.replace(/\n/g, " "))) {
    findings.push(
      `Second event after reinitialize was not accepted: ${statuses.statusAfterSecondEvent}`,
    );
  }

  const rumCanaries = await sendIntake("rum", createRumCanaries(testRunId));
  const logCanary = await sendIntake("logs", [createLogCanary(testRunId)]);
  if (rumCanaries.status >= 400) {
    findings.push(`Deterministic RUM canary ingestion returned status ${rumCanaries.status}.`);
  }
  if (logCanary.status >= 400) {
    findings.push(`Deterministic log canary ingestion returned status ${logCanary.status}.`);
  }

  log("verify:openobserve:ingestion — searching OpenObserve for real ingested telemetry...");

  const testRunFilter = `test_run_id='${escapeSqlLiteral(testRunId)}'`;
  const views = await pollSearch(
    auth,
    `select * from _rumdata where ${testRunFilter} and type='view' limit 5`,
    {
      startUs: startedUs,
    },
  );
  if (views.status !== 200 || views.hits.length === 0) {
    findings.push(`No current-run RUM session/view records found in _rumdata for ${testRunId}.`);
  }

  const actions = await pollSearch(
    auth,
    `select * from _rumdata where ${testRunFilter} and type='action' limit 20`,
    { startUs: startedUs },
  );
  if (actions.status !== 200 || actions.hits.length === 0) {
    findings.push(`No current-run RUM custom action records found in _rumdata for ${testRunId}.`);
  }

  const errors = await pollSearch(
    auth,
    `select * from _rumdata where ${testRunFilter} and type='error' limit 20`,
    { startUs: startedUs },
  );
  if (errors.status !== 200 || errors.hits.length === 0) {
    findings.push(`No current-run RUM error records found in _rumdata for ${testRunId}.`);
  }

  const resources = await pollSearch(
    auth,
    `select * from _rumdata where ${testRunFilter} and type='resource' limit 20`,
    { startUs: startedUs },
  );
  if (resources.status !== 200 || resources.hits.length === 0) {
    findings.push(
      `No current-run RUM network/resource records found in _rumdata for ${testRunId}.`,
    );
  }

  const canary = await pollSearch(
    auth,
    `select * from _rumlog where ${testRunFilter} and message='openobserve.regression-log' limit 5`,
    { startUs: startedUs },
  );
  if (canary.status !== 200 || canary.hits.length === 0) {
    findings.push(`No current-run browser-log canary found in _rumlog for ${testRunId}.`);
  } else {
    const hit = canary.hits[0];
    if (hit.message !== "openobserve.regression-log" || hit.test_run_id !== testRunId) {
      findings.push("Browser-log canary is missing expected message/test_run_id fields.");
    }
  }

  const rumdataHits = [...views.hits, ...actions.hits, ...errors.hits, ...resources.hits];
  for (const hit of rumdataHits) {
    if (hit.service !== DEMO_IDENTITY.service)
      findings.push(`_rumdata record has unexpected service: ${hit.service}`);
    if (hit.env !== DEMO_IDENTITY.environment)
      findings.push(`_rumdata record has unexpected env: ${hit.env}`);
    if (hit.version !== DEMO_IDENTITY.version)
      findings.push(`_rumdata record has unexpected version: ${hit.version}`);
    if (hit.application_id !== RUM_APPLICATION_ID)
      findings.push(`_rumdata record has unexpected application_id: ${hit.application_id}`);
  }

  for (const hit of canary.hits ?? []) {
    if (hit.service !== DEMO_IDENTITY.service)
      findings.push(`_rumlog record has unexpected service: ${hit.service}`);
    if (hit.env !== DEMO_IDENTITY.environment)
      findings.push(`_rumlog record has unexpected env: ${hit.env}`);
    if (hit.version !== DEMO_IDENTITY.version)
      findings.push(`_rumlog record has unexpected version: ${hit.version}`);
    if (hit.application_id !== RUM_APPLICATION_ID)
      findings.push(`_rumlog record has unexpected application_id: ${hit.application_id}`);
  }

  log("verify:openobserve:ingestion — checking absence of forbidden data...");

  const replay = await adminSearch(auth, "select * from _rumreplay limit 1").catch(() => ({
    status: 0,
    hits: [],
  }));
  if (replay.status === 200 && replay.hits.length > 0) {
    findings.push(
      "Session replay data was found (_rumreplay has records) — replay must never be recorded.",
    );
  }

  const haystack = JSON.stringify([
    ...views.hits,
    ...actions.hits,
    ...errors.hits,
    ...resources.hits,
  ]);
  if (haystack.includes(password) || haystack.includes(email)) {
    findings.push("Root admin credential literal appears inside ingested RUM data.");
  }
  if (/authorization|"cookie"/i.test(haystack)) {
    findings.push("Ingested RUM data appears to contain an Authorization/Cookie field.");
  }
  if (/request_body|response_body|"body"\s*:/i.test(haystack)) {
    findings.push("Ingested RUM data appears to contain a request/response body field.");
  }
  if (haystack.includes(JSON.stringify(runtimeConfig))) {
    findings.push("The entire runtime config was found embedded in ingested RUM data.");
  }

  log("verify:openobserve:ingestion — checking RUM token capability boundaries...");

  const rumAuthAttempts = [`Bearer ${rumToken}`, basicAuthHeader("rum", rumToken)];
  for (const rumAuth of rumAuthAttempts) {
    const searchAttempt = await adminSearch(rumAuth, "select * from _rumdata limit 1");
    if (searchAttempt.status < 400) {
      findings.push(
        `RUM token unexpectedly authorized a _search call (status ${searchAttempt.status}).`,
      );
    }
  }

  const managementProbes = [
    { path: `/api/${ORG_ID}/streams`, method: "GET" },
    { path: `/api/${ORG_ID}/dashboards`, method: "GET" },
    { path: `/api/${ORG_ID}/alerts`, method: "GET" },
    { path: `/api/${ORG_ID}/users`, method: "GET" },
    { path: "/api/organizations", method: "GET" },
    { path: `/api/${ORG_ID}/rumtoken`, method: "GET" },
  ];
  for (const probe of managementProbes) {
    const response = await fetch(`${OPENOBSERVE_ADMIN_URL}${probe.path}`, {
      method: probe.method,
      headers: { Authorization: `Bearer ${rumToken}` },
    });
    if (response.status < 400) {
      findings.push(
        `RUM token unexpectedly authorized ${probe.method} ${probe.path} (status ${response.status}).`,
      );
    }
  }

  return { pass: findings.length === 0, findings };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:openobserve:ingestion");
    const result = await verifyOpenObserveIngestion();
    if (result.pass) {
      log("\n✔ OpenObserve integration OpenObserve integration verification PASSED.");
    } else {
      logError("\n✖ OpenObserve integration OpenObserve integration verification FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:openobserve:ingestion FAILED: ${error.message}`);
    process.exit(1);
  }
}
