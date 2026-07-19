import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

import {
  assertExactLabToolchain,
  emailSecretPath,
  log,
  logError,
  passwordSecretPath,
  runtimeConfigPath,
} from "./common.mjs";
import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";
import { RUM_APPLICATION_ID } from "./generate-runtime-config.mjs";

const DEMO_URL = "https://localhost:8443";
const OPENOBSERVE_ADMIN_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";
const NOW_US = () => Date.now() * 1000;

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
    // unrelated Stage 7 test) so this exercises the real SDK's
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

export async function verifyStage8OpenObserve() {
  const findings = [];
  const { email, password } = readAdminCredentials();
  const auth = basicAuthHeader(email, password);
  const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
  const rumToken = runtimeConfig.rum?.clientToken;

  if (typeof rumToken !== "string" || rumToken.length < 16) {
    findings.push("Generated runtime config has no usable rum.clientToken.");
    return { pass: false, findings };
  }

  log("verify:stage8:openobserve — driving the demo through a real browser...");
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

  // Give the ingest pipeline a moment to become searchable.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  log("verify:stage8:openobserve — searching OpenObserve for real ingested telemetry...");

  const views = await adminSearch(auth, "select * from _rumdata where type='view' limit 5");
  if (views.status !== 200 || views.hits.length === 0) {
    findings.push("No RUM session/view records found in _rumdata.");
  }

  const actions = await adminSearch(auth, "select * from _rumdata where type='action' limit 20");
  if (actions.status !== 200 || actions.hits.length === 0) {
    findings.push("No RUM custom action records found in _rumdata.");
  }

  const errors = await adminSearch(auth, "select * from _rumdata where type='error' limit 20");
  if (errors.status !== 200 || errors.hits.length === 0) {
    findings.push("No RUM error records (runtime error / unhandled rejection) found in _rumdata.");
  }

  const resources = await adminSearch(
    auth,
    "select * from _rumdata where type='resource' limit 20",
  );
  if (resources.status !== 200 || resources.hits.length === 0) {
    findings.push("No RUM network/resource records found in _rumdata.");
  }

  const canary = await adminSearch(
    auth,
    "select * from _rumlog where message='stage8.browser_logs.canary' limit 5",
  );
  if (canary.status !== 200 || canary.hits.length === 0) {
    findings.push("Browser-log canary (stage8.browser_logs.canary) not found in _rumlog.");
  } else {
    const hit = canary.hits[0];
    if (hit.component !== "demo-fixture" || hit.outcome !== "success") {
      findings.push("Browser-log canary is missing expected component/outcome fields.");
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

  log("verify:stage8:openobserve — checking absence of forbidden data...");

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

  log("verify:stage8:openobserve — checking RUM token capability boundaries...");

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
    assertExactLabToolchain("test:stage8:openobserve");
    const result = await verifyStage8OpenObserve();
    if (result.pass) {
      log("\n✔ Stage 8 OpenObserve integration verification PASSED.");
    } else {
      logError("\n✖ Stage 8 OpenObserve integration verification FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:stage8:openobserve FAILED: ${error.message}`);
    process.exit(1);
  }
}
