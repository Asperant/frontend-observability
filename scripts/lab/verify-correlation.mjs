import { readFileSync } from "node:fs";
import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  emailSecretPath,
  log,
  logError,
  passwordSecretPath,
} from "./common.mjs";

const DEMO_URL = "https://localhost:8443";
const OPENOBSERVE_ADMIN_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";
const NOW_US = () => Date.now() * 1000;
const POLL_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 750;

const CORRELATION_KEYS = Object.freeze({
  schemaVersion: [
    "frontend-observability.correlation.schema_version",
    "frontend_observability_correlation_schema_version",
    "context_frontend_observability_correlation_schema_version",
    "context_frontend-observability.correlation.schema_version",
  ],
  epochId: [
    "frontend-observability.correlation.epoch_id",
    "frontend_observability_correlation_epoch_id",
    "context_frontend_observability_correlation_epoch_id",
    "context_frontend-observability.correlation.epoch_id",
  ],
  sessionId: [
    "frontend-observability.correlation.session_id",
    "frontend_observability_correlation_session_id",
    "context_frontend_observability_correlation_session_id",
    "context_frontend-observability.correlation.session_id",
  ],
  viewId: [
    "frontend-observability.correlation.view_id",
    "frontend_observability_correlation_view_id",
    "context_frontend_observability_correlation_view_id",
    "context_frontend-observability.correlation.view_id",
  ],
  actionId: [
    "frontend-observability.correlation.action_id",
    "frontend_observability_correlation_action_id",
    "context_frontend_observability_correlation_action_id",
    "context_frontend-observability.correlation.action_id",
  ],
});

const FORBIDDEN_HEADERS = Object.freeze([
  "traceparent",
  "tracestate",
  "baggage",
  "x-request-id",
  "x-correlation-id",
  "x-datadog-trace-id",
  "x-datadog-parent-id",
]);

function readAdminCredentials() {
  return {
    email: readFileSync(emailSecretPath, "utf8").trim(),
    password: readFileSync(passwordSecretPath, "utf8").trim(),
  };
}

function basicAuthHeader(email, password) {
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

async function adminSearch(auth, sql, { startUs, endUs = NOW_US() } = {}) {
  const response = await fetch(`${OPENOBSERVE_ADMIN_URL}/api/${ORG_ID}/_search?type=logs`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { sql, start_time: startUs, end_time: endUs } }),
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

async function driveBrowser(browserType, testRunId) {
  const browser = await browserType.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript((id) => {
      globalThis.__FRONTEND_OBSERVABILITY_TEST_RUN_ID__ = id;
    }, testRunId);
    const page = await context.newPage();
    await page.goto(DEMO_URL);

    async function click(id) {
      await page.getByTestId(`scenario-${id}`).click();
      await page.waitForTimeout(350);
    }

    await click("initialize-runtime-config");
    const initialStatus = await page.getByTestId("status-panel").innerText();
    await click("consent-grant");
    const grantedStatus = await page.getByTestId("status-panel").innerText();

    await click("record-action");
    await click("success-request");
    await click("record-error");

    const headerPresence = await page.evaluate(async () => {
      const response = await fetch("/mock/headers");
      return response.json();
    });

    await page.evaluate(() => {
      globalThis.history.pushState({}, "", `/correlation-view-b-${Date.now()}`);
      globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
    });
    await page.waitForTimeout(700);
    await click("safe-action");
    await click("success-request");

    await click("consent-revoke");
    await click("unsafe-attributes");

    await click("consent-grant");
    await click("pii-redacted-action");

    await page.waitForTimeout(1500);
    await Promise.all([
      page.waitForRequest((request) => new URL(request.url()).pathname.startsWith("/rum/v1/"), {
        timeout: 15_000,
      }),
      page.reload(),
    ]);

    const finalStatus = await page.getByTestId("status-panel").innerText();
    await context.close();
    return { initialStatus, grantedStatus, finalStatus, headerPresence };
  } finally {
    await browser.close();
  }
}

function findCorrelationValue(hit, key) {
  const aliases = CORRELATION_KEYS[key];
  return findValue(hit, aliases);
}

function findValue(value, aliases) {
  if (!value || typeof value !== "object") return undefined;
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(value, alias)) return value[alias];
  }
  for (const child of Object.values(value)) {
    const found = findValue(child, aliases);
    if (found !== undefined) return found;
  }
  return undefined;
}

function actionName(hit) {
  return findValue(hit, ["action_target_name", "action.target.name", "target_name"]);
}

function eventType(hit) {
  return hit.type ?? hit.event_type;
}

function timestamp(hit) {
  return Number(hit._timestamp ?? hit.date ?? 0);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function queryByCorrelationField(stream, field, value, extra = "1=1") {
  return `select * from ${stream} where ${field}='${escapeSqlLiteral(value)}' and ${extra} order by _timestamp asc limit 200`;
}

async function searchByCorrelation(auth, stream, key, value, { startUs, extra } = {}) {
  for (const field of CORRELATION_KEYS[key].filter((item) => !item.includes("."))) {
    const result = await pollSearch(auth, queryByCorrelationField(stream, field, value, extra), {
      startUs,
    });
    if (result.status === 200 && result.hits.length > 0) return result;
  }
  return { status: 200, hits: [] };
}

function assertNoForbiddenHeaders(headerPresence, findings, label) {
  const values = headerPresence?.forbiddenCorrelationHeaders ?? {};
  for (const header of FORBIDDEN_HEADERS) {
    if (values[header] !== false)
      findings.push(`${label}: forbidden business header ${header} was present.`);
  }
}

async function verifyBrowser(browserName, browserType, auth) {
  const findings = [];
  const testRunId = createSafeTestRunId(browserName);
  const startUs = NOW_US() - 5_000_000;
  const statuses = await driveBrowser(browserType, testRunId);

  if (!statuses.initialStatus.includes("active"))
    findings.push(`${browserName}: runtime did not activate.`);
  if (!statuses.grantedStatus.includes("correlationState")) {
    findings.push(`${browserName}: status did not include safe correlation snapshot.`);
  }
  if (JSON.stringify(statuses).includes("frontend-observability.correlation.epoch_id")) {
    findings.push(`${browserName}: status leaked a correlation field name/value unexpectedly.`);
  }
  assertNoForbiddenHeaders(statuses.headerPresence, findings, browserName);

  const rum = await pollSearch(
    auth,
    `select * from _rumdata where test_run_id='${escapeSqlLiteral(testRunId)}' limit 200`,
    { startUs },
  );
  if (rum.status !== 200 || rum.hits.length === 0) {
    findings.push(`${browserName}: no current-run RUM records found.`);
    return findings;
  }

  const firstAction = rum.hits.find((hit) => actionName(hit) === "demo.record-action");
  const regrantAction = rum.hits.find((hit) => actionName(hit) === "demo.pii-action");
  const revokedAction = rum.hits.find((hit) => actionName(hit) === "demo.unsafe-attributes");
  if (!firstAction) findings.push(`${browserName}: first controlled action missing.`);
  if (!regrantAction) findings.push(`${browserName}: regrant controlled action missing.`);
  if (revokedAction) findings.push(`${browserName}: revoke window produced telemetry.`);

  const firstEpoch = firstAction && findCorrelationValue(firstAction, "epochId");
  const regrantEpoch = regrantAction && findCorrelationValue(regrantAction, "epochId");
  const sessionId = firstAction && findCorrelationValue(firstAction, "sessionId");
  const viewA = firstAction && findCorrelationValue(firstAction, "viewId");
  if (!firstEpoch || !sessionId || !viewA) {
    findings.push(`${browserName}: first action is missing epoch/session/view correlation.`);
    return findings;
  }
  if (!regrantEpoch || regrantEpoch === firstEpoch) {
    findings.push(`${browserName}: regrant did not produce a different epoch.`);
  }

  const timeline = await searchByCorrelation(auth, "_rumdata", "epochId", firstEpoch, {
    startUs,
  });
  if (timeline.hits.length === 0)
    findings.push(`${browserName}: exact epoch RUM query returned no hits.`);
  const viewIds = unique(timeline.hits.map((hit) => findCorrelationValue(hit, "viewId")));
  if (viewIds.length < 2)
    findings.push(`${browserName}: session did not contain two distinct views.`);

  const typesInViewA = new Set(
    timeline.hits
      .filter((hit) => findCorrelationValue(hit, "viewId") === viewA)
      .map((hit) => eventType(hit)),
  );
  for (const type of ["action", "resource", "error"]) {
    if (!typesInViewA.has(type))
      findings.push(`${browserName}: View A missing ${type} correlation.`);
  }

  const actionIds = unique(timeline.hits.map((hit) => findCorrelationValue(hit, "actionId")));
  if (actionIds.length > 0) {
    const mismatched = timeline.hits.some((hit) => {
      const id = findCorrelationValue(hit, "actionId");
      return id && !actionIds.includes(id);
    });
    if (mismatched) findings.push(`${browserName}: native action IDs are inconsistent.`);
  }

  const logHits = await searchByCorrelation(auth, "_rumlog", "epochId", firstEpoch, { startUs });
  if (logHits.hits.length === 0) {
    findings.push(`${browserName}: no browser-log record found for first epoch.`);
  } else {
    const logWithSameView = logHits.hits.some(
      (hit) => findCorrelationValue(hit, "viewId") === viewA,
    );
    if (!logWithSameView) findings.push(`${browserName}: browser log did not share View A.`);
  }

  const oldEpochNewAction = timeline.hits.find((hit) => actionName(hit) === "demo.pii-action");
  if (oldEpochNewAction) findings.push(`${browserName}: new regrant event appeared in old epoch.`);

  const ordered = [...timeline.hits].sort((a, b) => timestamp(a) - timestamp(b));
  if (JSON.stringify(ordered.map(timestamp)) !== JSON.stringify(timeline.hits.map(timestamp))) {
    findings.push(`${browserName}: timeline query was not timestamp ordered.`);
  }
  const unsafeFields = JSON.stringify([...rum.hits, ...logHits.hits]).toLowerCase();
  for (const forbidden of ["user_id", "customer_id", "tenant_id", "account_id", "tckn", "vkn"]) {
    if (unsafeFields.includes(forbidden))
      findings.push(`${browserName}: forbidden identity field stored.`);
  }

  return findings;
}

function createSafeTestRunId(browserName) {
  const browser = browserName.slice(0, 2);
  const time = Date.now().toString(36).slice(-4);
  const suffix = Math.floor(Math.random() * 46_656)
    .toString(36)
    .padStart(3, "0");
  return `c-${browser}-${process.pid.toString(36).slice(-2)}-${time}-${suffix}`;
}

export async function verifyCorrelation() {
  const { email, password } = readAdminCredentials();
  const auth = basicAuthHeader(email, password);
  log(
    "verify:correlation:correlation — driving Chromium and Firefox through correlated telemetry...",
  );
  const findings = [
    ...(await verifyBrowser("chromium", chromium, auth)),
    ...(await verifyBrowser("firefox", firefox, auth)),
  ];
  return { pass: findings.length === 0, findings };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:correlation");
    const result = await verifyCorrelation();
    if (result.pass) {
      log("test:correlation PASSED.");
    } else {
      logError("test:correlation FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:correlation FAILED: ${error.message}`);
    process.exit(1);
  }
}
