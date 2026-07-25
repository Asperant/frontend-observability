import { readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";

import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  caCertPath,
  controlPlaneStateDir,
  log,
  logError,
  runDockerCompose,
} from "./common.mjs";
import {
  generateRuntimeControl,
  publishRuntimeControlText,
  readCurrentRuntimeControl,
} from "./generate-runtime-control.mjs";
import { killSwitchOff, killSwitchOn } from "./kill-switch.mjs";
import {
  readProxyGateActive,
  reloadReverseProxy,
  waitForReloadSettle,
  writeProxyGate,
} from "./proxy-gate.mjs";
import { waitForHealthy } from "./wait.mjs";

const PROXY_ORIGIN = "https://localhost:8443";
const PROXY_HOST = "localhost:8443";
const RUM_PATH = "/rum/v1/default/rum";
const LOGS_PATH = "/rum/v1/default/logs";
const CONTROL_PATH = "/observability/control.json";

const BROWSERS = [
  ["chromium", chromium],
  ["firefox", firefox],
];

function ingestionHeaders(extra = {}) {
  return {
    Host: PROXY_HOST,
    Origin: PROXY_ORIGIN,
    "Content-Type": "text/plain;charset=UTF-8",
    ...extra,
  };
}

function requestProxyOnce(
  path,
  { method = "POST", headers = ingestionHeaders(), body = "{}" } = {},
) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method,
        host: "127.0.0.1",
        port: 8443,
        path,
        headers:
          body === undefined ? headers : { ...headers, "Content-Length": Buffer.byteLength(body) },
        ca: readFileSync(caCertPath),
        servername: "localhost",
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
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

/**
 * `nginx -s reload` gracefully retires old worker processes rather than
 * dropping them instantly, so a request issued immediately after a reload
 * can occasionally land on a worker mid-shutdown and see a connection reset
 * ("socket hang up") instead of a real response. One retry after a short
 * pause is enough to tell that apart from an actual proxy bug.
 */
async function requestProxy(path, options) {
  try {
    return await requestProxyOnce(path, options);
  } catch {
    await waitForReloadSettle(500);
    return requestProxyOnce(path, options);
  }
}

async function waitForTestIdText(page, testId, expectedSubstring, timeoutMs = 25_000) {
  try {
    await page.waitForFunction(
      // Runs inside the browser page, not this Node script.
      ({ testId, expectedSubstring }) => {
        // eslint-disable-next-line no-undef
        const el = document.querySelector(`[data-testid="${testId}"]`);
        return Boolean(el && el.textContent.includes(expectedSubstring));
      },
      { testId, expectedSubstring },
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

function getTestIdText(page, testId) {
  return page.locator(`[data-testid="${testId}"]`).textContent();
}

/**
 * The real OpenObserve RUM/logs SDK batches outgoing events and only
 * auto-flushes every ~30s, or on a page-exit signal — see
 * tests/contract/native-delivery-limitation.test.js. Waiting out a full 30s
 * per assertion (or navigating away, which would reset this page's
 * in-memory runtime-control registry that several of these checks
 * specifically need to survive) is both slow and unnecessary:
 * recordAction()/recordError() return { ok, reasonCode } synchronously the
 * moment the call is accepted or rejected by this package's own gate —
 * independent of whether the vendor SDK has actually flushed anything to
 * the network yet (it batches for up to ~30s). This fixture's
 * "Activity log" panel renders that exact return value, newest first, so
 * this is the reliable way to assert "the package accepted this call"
 * without depending on SDK batching/flush timing.
 */
async function latestActivityLogWasOk(page) {
  const text = await page.locator('[data-testid="activity-log"] li').first().textContent();
  return Boolean(text && text.includes('"ok":true'));
}

async function withPage(engine, fn) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function initializeAndGrant(page, findings, label) {
  await page.goto(PROXY_ORIGIN);
  await page.getByTestId("scenario-initialize-runtime-config").click();
  const active = await waitForTestIdText(page, "status-panel", "active");
  if (!active) findings.push(`${label}: page did not reach active state after initialize.`);
  await page.getByTestId("scenario-consent-grant").click();
}

async function resetToCleanState() {
  clearScopedControlDocuments();
  await killSwitchOff();
  generateRuntimeControl({ killSwitch: { active: false, reasonCode: "none" } });
}

function clearScopedControlDocuments() {
  rmSync(`${controlPlaneStateDir}/scoped-controls`, { recursive: true, force: true });
}

// ---------------------------------------------------------------- Normal --

async function checkNormalFlow(findings) {
  await resetToCleanState();

  for (const [name, engine] of BROWSERS) {
    await withPage(engine, async (page) => {
      const controlRequests = [];
      const rumRequests = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === CONTROL_PATH) controlRequests.push(Date.now());
        if (url.pathname === RUM_PATH) rumRequests.push(request.postData() ?? "");
      });

      await initializeAndGrant(page, findings, `${name} normal`);

      const revisionText = await getTestIdText(page, "runtime-control-revision");
      if (!/^\d+$/.test((revisionText ?? "").trim())) {
        findings.push(`${name} normal: runtimeControl revision is not a number (${revisionText}).`);
      }
      const stateText = await getTestIdText(page, "runtime-control-state");
      if (stateText !== "fresh") {
        findings.push(`${name} normal: expected runtimeControl.state "fresh", got "${stateText}".`);
      }

      await page.getByTestId("scenario-record-action").click();
      await Promise.all([
        page.waitForRequest((request) => new URL(request.url()).pathname === RUM_PATH, {
          timeout: 10_000,
        }),
        page.reload(),
      ]);
      await page.waitForTimeout(300);

      if (rumRequests.length === 0) {
        findings.push(`${name} normal: no RUM telemetry was observed after consent + action.`);
      }
      if (rumRequests.some((body) => body.includes("control.json"))) {
        findings.push(
          `${name} normal: a control-endpoint fetch leaked into RUM resource telemetry.`,
        );
      }
      if (controlRequests.length === 0) {
        findings.push(`${name} normal: no control-document fetch was observed.`);
      }
      // Single polling loop: the initial fetch plus, within this short a
      // window, at most one more (e.g. the reload above re-initializing).
      // What must never happen is *concurrent* duplicate fetches at the same
      // instant, which a tight-clustering check below approximates.
      const sorted = [...controlRequests].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] - sorted[i - 1] < 50) {
          findings.push(
            `${name} normal: two control-document fetches fired within 50ms of each other (overlapping poll).`,
          );
        }
      }
    });
  }
}

// -------------------------------------------------------- Browser switch --

async function checkBrowserKillSwitch(findings) {
  await resetToCleanState();

  for (const [name, engine] of BROWSERS) {
    await withPage(engine, async (page) => {
      await initializeAndGrant(page, findings, `${name} browser-kill-switch`);
      await page.getByTestId("scenario-record-action").click();
      await page.waitForTimeout(500);

      const requestsAfterKill = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === RUM_PATH || url.pathname === LOGS_PATH)
          requestsAfterKill.push(url.pathname);
      });

      // Browser-layer only: the proxy gate is left open on purpose, so a
      // 410 from the proxy can never be mistaken for the browser gate
      // working.
      generateRuntimeControl({ killSwitch: { active: true, reasonCode: "security_incident" } });

      const latched = await waitForTestIdText(page, "kill-switch-latched", "true", 40_000);
      if (!latched)
        findings.push(
          `${name} browser-kill-switch: killSwitch never latched within one refresh cycle.`,
        );
      const killSwitched = await waitForTestIdText(
        page,
        "runtime-control-state",
        "kill-switched",
        5_000,
      );
      if (!killSwitched)
        findings.push(`${name} browser-kill-switch: status never reported "kill-switched".`);

      await page.getByTestId("scenario-record-action").click();
      await page.getByTestId("scenario-record-error").click();
      await page.waitForTimeout(1500);
      if (requestsAfterKill.length > 0) {
        findings.push(
          `${name} browser-kill-switch: telemetry still reached storage after activation.`,
        );
      }

      // Host frontend keeps working.
      const bodyVisible = await page.locator("body").isVisible();
      if (!bodyVisible) findings.push(`${name} browser-kill-switch: host page stopped rendering.`);

      // active:false, same page, does not reopen (latch).
      generateRuntimeControl({ killSwitch: { active: false, reasonCode: "none" } });
      await page.waitForTimeout(2000);
      const stillLatched = (await getTestIdText(page, "kill-switch-latched")) === "true";
      if (!stillLatched)
        findings.push(
          `${name} browser-kill-switch: latch cleared on the same page without a reload.`,
        );

      const requestsAfterReopenAttempt = requestsAfterKill.length;
      await page.getByTestId("scenario-record-action").click();
      await page.waitForTimeout(1000);
      if (requestsAfterKill.length !== requestsAfterReopenAttempt) {
        findings.push(`${name} browser-kill-switch: telemetry resumed without a page reload.`);
      }

      // A full reload with active:false does resume.
      await page.reload();
      await page.getByTestId("scenario-initialize-runtime-config").click();
      const activeAgain = await waitForTestIdText(page, "status-panel", "active");
      if (!activeAgain)
        findings.push(`${name} browser-kill-switch: reload did not resume initialization.`);
      const unlatched = (await getTestIdText(page, "kill-switch-latched")) === "false";
      if (!unlatched) findings.push(`${name} browser-kill-switch: reload did not clear the latch.`);
      await page.getByTestId("scenario-consent-grant").click();
      await page.getByTestId("scenario-record-action").click();
      await page.waitForTimeout(300);
      const resumedRequest = await latestActivityLogWasOk(page);
      if (!resumedRequest)
        findings.push(
          `${name} browser-kill-switch: telemetry did not resume after reload with active:false.`,
        );
    });
  }

  await resetToCleanState();
}

// ---------------------------------------------------------- Proxy switch --

async function checkProxyKillSwitch(findings) {
  await resetToCleanState();

  writeProxyGate(true);
  reloadReverseProxy();
  await waitForReloadSettle();
  try {
    for (const path of [RUM_PATH, LOGS_PATH]) {
      const response = await requestProxy(path);
      if (response.statusCode !== 410)
        findings.push(`proxy-kill-switch: ${path} returned ${response.statusCode}, expected 410.`);
      if (response.headers["cache-control"] !== "no-store") {
        findings.push(`proxy-kill-switch: ${path} missing Cache-Control: no-store.`);
      }
      if (response.headers["x-content-type-options"] !== "nosniff") {
        findings.push(`proxy-kill-switch: ${path} missing X-Content-Type-Options: nosniff.`);
      }
    }

    // Upstream isolation: even with OpenObserve fully stopped, the 410
    // response must be identical — proof nginx never attempted proxy_pass.
    runDockerCompose(["stop", "openobserve"]);
    try {
      const response = await requestProxy(LOGS_PATH);
      if (response.statusCode !== 410) {
        findings.push(
          `proxy-kill-switch: ${LOGS_PATH} did not stay 410 with OpenObserve stopped (got ${response.statusCode}).`,
        );
      }
    } finally {
      runDockerCompose(["start", "openobserve"]);
      const health = await waitForHealthy({ services: ["openobserve"], timeoutMs: 120_000 });
      if (!health.healthy)
        findings.push("proxy-kill-switch: openobserve did not recover after isolation probe.");
    }

    // No retry storm: a real browser sending several actions against an
    // active kill switch must only ever produce the same small, bounded
    // number of POSTs the SDK's own batching would normally produce — never
    // an escalating retry pattern (410 is not one of the SDK's own
    // retry-triggering statuses: 408/429/5xx — see
    // docs/openobserve-sdk-delivery-behavior.md).
    await withPage(chromium, async (page) => {
      let postCount = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === RUM_PATH) postCount += 1;
      });
      await page.goto(PROXY_ORIGIN);
      await page.getByTestId("scenario-initialize-runtime-config").click();
      await page.getByTestId("scenario-consent-grant").click();
      for (let i = 0; i < 5; i += 1) {
        await page.getByTestId("scenario-record-action").click();
      }
      await page.waitForTimeout(8_000);
      if (postCount > 5) {
        findings.push(
          `proxy-kill-switch: observed ${postCount} RUM POSTs for 5 actions — looks like a retry storm.`,
        );
      }
      const bodyVisible = await page.locator("body").isVisible();
      if (!bodyVisible)
        findings.push("proxy-kill-switch: host page stopped rendering while the proxy was 410ing.");
    });
  } finally {
    writeProxyGate(false);
    reloadReverseProxy();
  }
}

// -------------------------------------------------------- Operator command --

/**
 * The full atomic `pnpm lab:kill-switch:on/off` sequence (both layers
 * together, in the exact activation/deactivation order from
 * docs/runtime-control-and-kill-switch.md), exercised end to end.
 */
async function checkOperatorCommand(findings) {
  await resetToCleanState();

  const onResult = await killSwitchOn({ reason: "operator_request" });
  if (!onResult.document.killSwitch.active)
    findings.push("operator-command: on() did not publish active:true.");
  if (!onResult.proxyGateActive)
    findings.push("operator-command: on() did not close the proxy gate.");
  const rumBlocked = await requestProxy(RUM_PATH);
  if (rumBlocked.statusCode !== 410) {
    findings.push(
      `operator-command: proxy still accepted ingestion after on() (got ${rumBlocked.statusCode}).`,
    );
  }

  const offResult = await killSwitchOff();
  if (offResult.document.killSwitch.active)
    findings.push("operator-command: off() left active:true published.");
  if (offResult.proxyGateActive)
    findings.push("operator-command: off() left the proxy gate closed.");
  const rumAllowed = await requestProxy(RUM_PATH, {
    body: JSON.stringify({
      date: Date.now(),
      type: "view",
      session_id: crypto.randomUUID(),
    }),
  });
  if (rumAllowed.statusCode !== 202) {
    findings.push(
      `operator-command: proxy still rejected ingestion after off() (got ${rumAllowed.statusCode}).`,
    );
  }
}

// ---------------------------------------------------------------- Expiry --

async function checkExpiry(findings) {
  await resetToCleanState();
  generateRuntimeControl({ ttlMs: 20_000 });

  await withPage(chromium, async (page) => {
    await initializeAndGrant(page, findings, "expiry");

    // Simulate the endpoint becoming unavailable/unusable for the rest of
    // this document's life: further fetches of the same stale content will
    // be rejected as EXPIRED (arrival-time rejection), same as a genuinely
    // unreachable endpoint would look from the client's perspective, and
    // the already-cached document's own expiresAt lapses regardless.
    await page.waitForTimeout(23_000);

    const expired = await waitForTestIdText(page, "runtime-control-state", "expired", 20_000);
    if (!expired) findings.push('expiry: runtimeControl.state never reported "expired".');

    const requestsAfterExpiry = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === RUM_PATH || url.pathname === LOGS_PATH)
        requestsAfterExpiry.push(url.pathname);
    });
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(1000);
    if (requestsAfterExpiry.length > 0) {
      findings.push("expiry: telemetry still reached storage after the control document expired.");
    }
  });

  await resetToCleanState();
}

// ------------------------------------------------------ Invalid documents --

function writeRawControlFile(text) {
  publishRuntimeControlText(text);
}

async function assertInvalidDocumentFailsClosed(findings, label) {
  await withPage(chromium, async (page) => {
    await page.goto(PROXY_ORIGIN);
    await page.getByTestId("scenario-initialize-runtime-config").click();
    const disabled = await waitForTestIdText(page, "status-panel", "disabled", 10_000);
    if (!disabled)
      findings.push(`invalid-document (${label}): page did not fail closed to "disabled".`);
  });
}

async function checkInvalidDocuments(findings) {
  await resetToCleanState();
  const good = readCurrentRuntimeControl();

  const cases = [
    ["malformed JSON", '{"schemaVersion":1,'],
    ["unknown field", JSON.stringify({ ...good, extra: true })],
    [
      "duplicate key",
      '{"schemaVersion":1,"revision":1,"revision":2,"issuedAt":"' +
        new Date().toISOString() +
        '","expiresAt":"' +
        new Date(Date.now() + 60_000).toISOString() +
        '","killSwitch":{"active":false,"reasonCode":"none"}}',
    ],
    ["negative revision", JSON.stringify({ ...good, revision: -1 })],
    [
      "future issuedAt",
      JSON.stringify({
        ...good,
        issuedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    ],
    [
      "expired document",
      JSON.stringify({
        ...good,
        issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    ],
    [
      "TTL overflow",
      JSON.stringify({
        ...good,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 11 * 60_000).toISOString(),
      }),
    ],
    [
      "wrong enum",
      JSON.stringify({ ...good, killSwitch: { active: true, reasonCode: "because" } }),
    ],
    ["oversized body", JSON.stringify({ ...good, padding: "x".repeat(9 * 1024) })],
  ];

  for (const [label, content] of cases) {
    writeRawControlFile(content);
    await assertInvalidDocumentFailsClosed(findings, label);
  }

  // Query string: rejected by the proxy itself, never reaching the browser.
  const queried = await requestProxy(`${CONTROL_PATH}?x=1`, {
    method: "GET",
    headers: { Host: PROXY_HOST },
    body: undefined,
  });
  if (queried.statusCode !== 404)
    findings.push(`invalid-document (query): expected 404, got ${queried.statusCode}.`);

  // Rollback: a valid, already-applied revision must not be downgraded by a
  // lower-revision document arriving later on the *same* page.
  generateRuntimeControl({ revision: 5, killSwitch: { active: false, reasonCode: "none" } });
  await withPage(chromium, async (page) => {
    await initializeAndGrant(page, findings, "rollback");
    const revisionBefore = await getTestIdText(page, "runtime-control-revision");

    writeRawControlFile(
      JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        killSwitch: { active: false, reasonCode: "none" },
      }),
    );
    // eslint-disable-next-line no-undef -- runs inside the browser page.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const rollbackRejected = await waitForTestIdText(
      page,
      "runtime-control-state",
      "rollback-rejected",
      10_000,
    );
    if (!rollbackRejected) findings.push('rollback: status never reported "rollback-rejected".');
    const revisionAfter = await getTestIdText(page, "runtime-control-revision");
    if (revisionAfter !== revisionBefore) {
      findings.push(
        `rollback: revision changed from ${revisionBefore} to ${revisionAfter} on a lower-revision document.`,
      );
    }

    // Cache is still live: the package still accepts new telemetry (checked
    // via recordAction()'s own return value rather than a network request,
    // since the vendor SDK batches for up to ~30s independently of this).
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(200);
    if (!(await latestActivityLogWasOk(page))) {
      findings.push(
        "rollback: recordAction() stopped succeeding even though the cached document is still live.",
      );
    }
  });

  await resetToCleanState();
}

// -------------------------------------------------------------- Lifecycle --

async function checkLifecycle(findings) {
  await resetToCleanState();

  await withPage(chromium, async (page) => {
    await initializeAndGrant(page, findings, "lifecycle");

    // duplicate init: same options, must stay a single loop/state.
    await page.getByTestId("scenario-duplicate-init").click();
    await page.waitForTimeout(200);
    const stillActive = (await getTestIdText(page, "status-panel")).includes("active");
    if (!stillActive) findings.push("lifecycle: duplicate init disturbed the active state.");

    // consent revoke is still honored.
    await page.getByTestId("scenario-consent-revoke").click();
    const revisionBeforeRevoke = await getTestIdText(page, "runtime-control-revision");
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(300);
    const revisionAfterRevoke = await getTestIdText(page, "runtime-control-revision");
    if (revisionBeforeRevoke !== revisionAfterRevoke) {
      findings.push("lifecycle: consent revoke unexpectedly changed runtime-control revision.");
    }
    await page.getByTestId("scenario-consent-grant").click();

    // shutdown stops the loop; singleton resume must not break.
    const controlRequestsBeforeShutdown = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === CONTROL_PATH) controlRequestsBeforeShutdown.push(1);
    });
    await page.getByTestId("scenario-shutdown").click();
    const shutdown = await waitForTestIdText(page, "status-panel", "shutdown", 5_000);
    if (!shutdown) findings.push("lifecycle: shutdown did not reach the shutdown state.");
    await page.waitForTimeout(3_000);
    const countAtCheckpoint = controlRequestsBeforeShutdown.length;
    await page.waitForTimeout(3_000);
    if (controlRequestsBeforeShutdown.length !== countAtCheckpoint) {
      findings.push("lifecycle: control-document polling continued after shutdown.");
    }

    await page.getByTestId("scenario-initialize-runtime-config").click();
    const resumedActive = await waitForTestIdText(page, "status-panel", "active", 10_000);
    if (!resumedActive)
      findings.push("lifecycle: reinitialize after shutdown did not resume to active.");
    const resumedReasonOk = !(await getTestIdText(page, "status-panel")).includes(
      "RUNTIME_CONTROL_UNAVAILABLE",
    );
    if (!resumedReasonOk)
      findings.push("lifecycle: reinitialize re-blocked on the control gate instead of resuming.");
  });

  await resetToCleanState();
}

// -------------------------------------------------------------------- run --

export async function verifyRuntimeControl() {
  const findings = [];

  log("runtime-control: normal control refresh flow (chromium + firefox)...");
  await checkNormalFlow(findings);

  log("runtime-control: browser kill switch...");
  await checkBrowserKillSwitch(findings);

  log("runtime-control: proxy kill switch...");
  await checkProxyKillSwitch(findings);

  log("runtime-control: operator command (full on/off sequence)...");
  await checkOperatorCommand(findings);

  log("runtime-control: expiry fail-closed...");
  await checkExpiry(findings);

  log("runtime-control: invalid/rollback control documents...");
  await checkInvalidDocuments(findings);

  log("runtime-control: lifecycle (duplicate init, consent, shutdown/resume)...");
  await checkLifecycle(findings);

  // Always leave the lab in a known-good, fully-open state for whatever
  // runs after this script.
  await resetToCleanState();
  if (readProxyGateActive()) findings.push("cleanup: proxy gate was left active.");

  return { pass: findings.length === 0, findings };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:runtime-control");
    const result = await verifyRuntimeControl();
    if (result.pass) {
      log("\nruntime-control runtime-control verification PASSED.");
    } else {
      logError("\nruntime-control runtime-control verification FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:runtime-control FAILED: ${error.message}`);
    process.exit(1);
  }
}
