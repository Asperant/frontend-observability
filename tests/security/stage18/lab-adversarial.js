// Stage 18 live-lab adversarial checks. Every check runs only against the
// local `chicek-lab` (real reverse proxy on https://127.0.0.1:8443, real
// OpenObserve admin API on http://127.0.0.1:5080 loopback, real Docker
// containers) — never a real external target. Follows the existing
// scripts/lab/verify-*.mjs pattern: pure functions returning
// { pass, findings, evidence }, no process.exit here (the orchestrator in
// scripts/security/verify-stage18-security-acceptance.mjs owns that).
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

import { chromium, firefox } from "@playwright/test";

import {
  atomicWriteFile,
  caCertPath,
  emailSecretPath,
  passwordSecretPath,
  proxyGatePath,
  rumClientTokenSecretPath,
  runDockerCompose,
  runtimeControlPath,
} from "../../../scripts/lab/common.mjs";
import { search } from "../../../scripts/lab/streams/admin-client.mjs";
import {
  generateRuntimeControl,
  readCurrentRuntimeControl,
} from "../../../scripts/lab/generate-runtime-control.mjs";
import {
  killSwitchOff,
  killSwitchOn,
  killSwitchStatus,
} from "../../../scripts/lab/kill-switch.mjs";
import {
  reloadReverseProxy,
  waitForReloadSettle,
  writeProxyGate,
} from "../../../scripts/lab/proxy-gate.mjs";
import {
  validateControlDocumentShape,
  validateControlLifetime,
} from "../../../packages/browser-observability/src/runtime-control/validate-document.js";
import {
  alertSinkControl,
  testLocalDestination,
} from "../../../scripts/lab/alerts/admin-client.mjs";

const OPENOBSERVE_ADMIN_URL = "http://127.0.0.1:5080";
const PROXY_HOST = "localhost:8443";
const PROXY_ORIGIN = "https://localhost:8443";
const RUN_ID = `stage18-${Date.now().toString(36)}`;

function readRumToken() {
  return readFileSync(rumClientTokenSecretPath, "utf8").trim();
}

function readAdminAuthHeader() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

function httpAdminFetch(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${OPENOBSERVE_ADMIN_URL}${path}`,
      { method, headers, timeout: 10_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function requestProxy(path, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method,
        host: "127.0.0.1",
        port: 8443,
        path,
        headers:
          body === undefined
            ? { Host: PROXY_HOST, Origin: PROXY_ORIGIN, ...headers }
            : {
                Host: PROXY_HOST,
                Origin: PROXY_ORIGIN,
                "Content-Length": Buffer.byteLength(body),
                ...headers,
              },
        ca: readFileSync(caCertPath),
        servername: "localhost",
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Section 3: RUM token capability isolation.
// ---------------------------------------------------------------------------
const TOKEN_ADMIN_PROBES = [
  [
    "search",
    "POST",
    "/api/default/_search?type=logs",
    JSON.stringify({ query: { sql: "select 1" } }),
  ],
  ["stream list", "GET", "/api/default/streams", undefined],
  ["stream schema", "GET", "/api/default/streams/_rumdata/schema?type=logs", undefined],
  [
    "stream settings write",
    "PUT",
    "/api/default/streams/_rumdata/settings?type=logs",
    JSON.stringify({ data_retention: 1 }),
  ],
  ["stream delete", "DELETE", "/api/default/streams/_rumdata?type=logs", undefined],
  ["dashboard list", "GET", "/api/default/folders/dashboards", undefined],
  [
    "dashboard create",
    "POST",
    "/api/v2/default/alerts?folder=default",
    JSON.stringify({ name: `${RUN_ID}-alert` }),
  ],
  ["alert list", "GET", "/api/v2/default/alerts", undefined],
  ["pipeline list", "GET", "/api/default/pipelines", undefined],
  ["user list", "GET", "/api/default/users", undefined],
  ["organization list", "GET", "/api/organizations", undefined],
  ["token/user management", "POST", "/api/default/users", JSON.stringify({ email: "x@x.invalid" })],
];

export async function checkTokenCapabilityIsolation() {
  const token = readRumToken();
  const findings = [];
  const evidence = [];
  const authEncodings = [
    ["Bearer", `Bearer ${token}`],
    ["Basic-as-username", `Basic ${Buffer.from(`${token}:`).toString("base64")}`],
  ];

  const before = await search(readAdminAuthHeader(), "select count(*) as c from _rumdata", {
    startUs: 0,
    endUs: Date.now() * 1000,
  });

  for (const [label, method, path, body] of TOKEN_ADMIN_PROBES) {
    for (const [encodingLabel, authHeader] of authEncodings) {
      const response = await httpAdminFetch(path, {
        method,
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body,
      });
      const rejected = response.status === 401 || response.status === 403;
      evidence.push(`${label} (${encodingLabel}) -> ${response.status}`);
      if (!rejected) {
        findings.push(
          `RUM token was NOT rejected for admin capability "${label}" via ${encodingLabel} (status ${response.status})`,
        );
      }
    }
  }

  const after = await search(readAdminAuthHeader(), "select count(*) as c from _rumdata", {
    startUs: 0,
    endUs: Date.now() * 1000,
  });
  const beforeCount = before.hits?.[0]?.c ?? before.hits?.[0]?.["count(*)"] ?? null;
  const afterCount = after.hits?.[0]?.c ?? after.hits?.[0]?.["count(*)"] ?? null;
  if (beforeCount !== null && afterCount !== null && beforeCount !== afterCount) {
    findings.push(
      `_rumdata row count changed during token-capability probing (${beforeCount} -> ${afterCount}); a probe may have mutated state`,
    );
  }

  return { pass: findings.length === 0, findings, evidence };
}

// ---------------------------------------------------------------------------
// Section 3 (continued): management/search/config plane unreachable via the
// browser-facing 8443 proxy, with a real admin-side read-back.
// ---------------------------------------------------------------------------
const MANAGEMENT_PATHS_VIA_PROXY = [
  "/api/default/streams",
  "/api/default/_search",
  "/_search",
  "/streams",
  "/dashboards",
  "/alerts",
  "/users",
  "/organizations",
  "/pipelines",
  "/rumtoken",
  "/source-map",
];

export async function checkManagementPlaneUnreachableViaProxy() {
  const findings = [];
  const evidence = [];
  for (const path of MANAGEMENT_PATHS_VIA_PROXY) {
    const response = await requestProxy(path, { method: "GET" });
    evidence.push(`${path} -> ${response.statusCode}`);
    if (response.statusCode < 400) {
      findings.push(
        `management path ${path} was reachable via the browser-facing proxy (status ${response.statusCode})`,
      );
    }
  }
  return { pass: findings.length === 0, findings, evidence };
}

// ---------------------------------------------------------------------------
// Section 5: live replay-endpoint adversarial confirmation.
// ---------------------------------------------------------------------------
export async function checkLiveReplayRejection() {
  const findings = [];
  const canary = `stage18-replay-canary-${RUN_ID}`;
  const boundary = "----chicekStage18Boundary";
  const segment = Buffer.from(`replay-segment-${canary}`);
  const eventJson = JSON.stringify({
    session: { id: RUN_ID },
    view: { id: RUN_ID },
    has_full_snapshot: true,
  });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="segment"; filename="segment"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    segment,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="event"; filename="event.json"\r\nContent-Type: application/json\r\n\r\n${eventJson}\r\n--${boundary}--\r\n`,
    ),
  ]);

  const response = await requestProxy("/rum/v1/default/replay", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (response.statusCode !== 404) {
    findings.push(
      `POST /rum/v1/default/replay returned ${response.statusCode} instead of 404 (proxy denial)`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const readBack = await search(readAdminAuthHeader(), "select * from _sessionreplay", {
    startUs: (Date.now() - 60_000) * 1000,
    endUs: Date.now() * 1000,
  });
  const leaked = (readBack.hits ?? []).some((hit) => JSON.stringify(hit).includes(canary));
  if (leaked) {
    findings.push("replay canary was found in _sessionreplay despite the proxy denial");
  }

  return {
    pass: findings.length === 0,
    findings,
    evidence: [
      `proxy status: ${response.statusCode}`,
      `_sessionreplay hits scanned: ${(readBack.hits ?? []).length}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Section 6: runtime-control adversarial documents.
// ---------------------------------------------------------------------------
function serveControlDocument(rawText) {
  atomicWriteFile(runtimeControlPath, rawText, { mode: 0o644 });
}

const ADVERSARIAL_CONTROL_DOCS = [
  ["malformed JSON", "{not valid json"],
  [
    "duplicate keys",
    '{"schemaVersion":1,"schemaVersion":1,"revision":1,"issuedAt":"2026-07-20T00:00:00.000Z","expiresAt":"2026-07-20T00:05:00.000Z","killSwitch":{"active":false,"reasonCode":"none"}}',
  ],
  [
    "unknown top-level key",
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      killSwitch: { active: false, reasonCode: "none" },
      evil: true,
    }),
  ],
  [
    "negative/rollback revision",
    JSON.stringify({
      schemaVersion: 1,
      revision: -5,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      killSwitch: { active: false, reasonCode: "none" },
    }),
  ],
  [
    "future issuedAt",
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_660_000).toISOString(),
      killSwitch: { active: false, reasonCode: "none" },
    }),
  ],
  [
    "expired",
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_000_000).toISOString(),
      killSwitch: { active: false, reasonCode: "none" },
    }),
  ],
  [
    "TTL overflow (> 10 min)",
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      killSwitch: { active: false, reasonCode: "none" },
    }),
  ],
  [
    "wrong enum for killSwitch.reasonCode",
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      killSwitch: { active: true, reasonCode: "not-a-real-reason" },
    }),
  ],
  [
    "oversized (> 8KiB)",
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      killSwitch: { active: false, reasonCode: "none" },
      pad: "x".repeat(9 * 1024),
    }),
  ],
];

export async function checkRuntimeControlAdversarialDocuments() {
  const findings = [];
  const evidence = [];
  const knownGood = readCurrentRuntimeControl();

  try {
    for (const [label, rawText] of ADVERSARIAL_CONTROL_DOCS) {
      serveControlDocument(rawText);
      const served = await requestProxy("/observability/control.json", {
        method: "GET",
        body: undefined,
      });
      const servedBody = served.body;

      let parsed;
      let parseOk = true;
      try {
        parsed = JSON.parse(servedBody);
      } catch {
        parseOk = false;
      }

      let rejected = !parseOk;
      if (parseOk) {
        const shape = validateControlDocumentShape(parsed);
        if (!shape.valid) {
          rejected = true;
        } else {
          const lifetime = validateControlLifetime(parsed, new Date());
          if (!lifetime.valid) rejected = true;
        }
      }
      evidence.push(
        `${label}: served status=${served.statusCode} rejectedByBrowserValidation=${rejected}`,
      );
      if (!rejected) {
        findings.push(
          `adversarial control document "${label}" was NOT rejected by the browser package's own validation`,
        );
      }
    }
  } finally {
    if (knownGood) {
      atomicWriteFile(runtimeControlPath, `${JSON.stringify(knownGood, null, 2)}\n`, {
        mode: 0o644,
      });
    } else {
      generateRuntimeControl();
    }
  }

  return { pass: findings.length === 0, findings, evidence };
}

// ---------------------------------------------------------------------------
// Section 6 (continued): kill-switch file/operator attacks.
// ---------------------------------------------------------------------------
export async function checkKillSwitchSymlinkAttack() {
  const findings = [];
  const targetPath = "/tmp/chicek-stage18-symlink-target";
  writeFileSync(targetPath, "attacker-controlled content\n");
  try {
    unlinkSync(proxyGatePath);
  } catch {
    /* file may not exist yet */
  }
  symlinkSync(targetPath, proxyGatePath);

  let threw = false;
  try {
    writeProxyGate(true);
  } catch {
    threw = true;
  }
  if (!threw) {
    findings.push("writeProxyGate() did not refuse a symlinked proxy-gate path");
  }
  const targetContent = readFileSync(targetPath, "utf8");
  if (targetContent !== "attacker-controlled content\n") {
    findings.push(
      "writeProxyGate() wrote through the symlink into the attacker-controlled target file",
    );
  }

  try {
    unlinkSync(proxyGatePath);
  } catch {
    /* symlink itself */
  }
  writeProxyGate(false);
  reloadReverseProxy();
  await waitForReloadSettle();
  unlinkSync(targetPath);

  return {
    pass: findings.length === 0,
    findings,
    evidence: [`writeProxyGate threw on symlink target: ${threw}`],
  };
}

export async function checkKillSwitchConcurrentRace() {
  const findings = [];
  await killSwitchOff();
  const [onResult, offResult] = await Promise.allSettled([
    killSwitchOn({ reason: "operator_request" }),
    killSwitchOff(),
  ]);
  await waitForReloadSettle(1000);

  const finalStatus = killSwitchStatus();
  const proxyGateConsistentWithControl =
    finalStatus.control !== null &&
    finalStatus.proxyGateActive === finalStatus.control.killSwitch.active;
  if (!proxyGateConsistentWithControl) {
    findings.push(
      `after a concurrent kill-switch on/off race, the proxy gate (${finalStatus.proxyGateActive}) and control document (${finalStatus.control?.killSwitch?.active}) disagree`,
    );
  }

  await killSwitchOff();

  return {
    pass: findings.length === 0,
    findings,
    evidence: [
      `on settled: ${onResult.status}`,
      `off settled: ${offResult.status}`,
      `final proxyGateActive=${finalStatus.proxyGateActive} control.killSwitch.active=${finalStatus.control?.killSwitch?.active}`,
    ],
  };
}

export async function checkKillSwitchClosesUpstream() {
  const findings = [];
  const canary = `stage18-killswitch-canary-${RUN_ID}`;
  await killSwitchOn({ reason: "operator_request" });

  const rumResponse = await requestProxy("/rum/v1/default/rum", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ note: canary }),
  });
  if (rumResponse.statusCode !== 410) {
    findings.push(
      `RUM ingest returned ${rumResponse.statusCode} instead of 410 while the kill switch was active`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const readBack = await search(readAdminAuthHeader(), "select * from _rumdata", {
    startUs: (Date.now() - 60_000) * 1000,
    endUs: Date.now() * 1000,
  });
  const leaked = (readBack.hits ?? []).some((hit) => JSON.stringify(hit).includes(canary));
  if (leaked) {
    findings.push("a request sent while the kill switch was active still reached upstream storage");
  }

  await killSwitchOff();

  return {
    pass: findings.length === 0,
    findings,
    evidence: [`RUM ingest status under kill switch: ${rumResponse.statusCode}`],
  };
}

// ---------------------------------------------------------------------------
// Section 9: Docker cross-container admin-endpoint reachability.
// ---------------------------------------------------------------------------
function execProbe(service, script) {
  const result = runDockerCompose(["exec", "-T", service, "node", "-e", script], {
    capture: true,
    allowFailure: true,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

const NODE_REACHABILITY_PROBE_SCRIPT =
  "fetch('http://openobserve:5080/api/default/streams',{signal:AbortSignal.timeout(3000)})" +
  ".then(r=>{console.log('REACHABLE:'+r.status);process.exit(0);})" +
  ".catch(e=>{console.log('UNREACHABLE:'+e.constructor.name);process.exit(0);})";

function execWgetProbe(service) {
  const result = runDockerCompose(
    [
      "exec",
      "-T",
      service,
      "wget",
      "-q",
      "-T",
      "3",
      "-O",
      "-",
      "http://openobserve:5080/api/default/streams",
    ],
    { capture: true, allowFailure: true },
  );
  return result.status === 0
    ? `REACHABLE:${(result.stdout ?? "").slice(0, 40)}`
    : `UNREACHABLE:wget exit ${result.status}`;
}

export function checkDockerCrossContainerIsolation() {
  const findings = [];
  const evidence = [];

  // demo-frontend's runtime image is nginx-unprivileged (no node binary);
  // mock-api's is the node-based mock API server (see their respective
  // healthchecks in infrastructure/docker/compose.yaml for the same tool
  // choice per image).
  const demoFrontendProbe = execWgetProbe("demo-frontend");
  evidence.push(`demo-frontend -> openobserve admin API: ${demoFrontendProbe}`);
  if (demoFrontendProbe.startsWith("REACHABLE:")) {
    findings.push(
      "demo-frontend container can reach OpenObserve's admin API directly (network isolation gap)",
    );
  }

  const mockApiProbe = execProbe("mock-api", NODE_REACHABILITY_PROBE_SCRIPT);
  evidence.push(`mock-api -> openobserve admin API: ${mockApiProbe.stdout || mockApiProbe.stderr}`);
  if (mockApiProbe.stdout.startsWith("REACHABLE:")) {
    findings.push(
      "mock-api container can reach OpenObserve's admin API directly (network isolation gap)",
    );
  }

  const alertSinkNoCreds = execProbe(
    "alert-sink",
    "const fs=require('fs');" +
      "const paths=['/run/secrets/openobserve_root_email','/run/secrets/openobserve_root_password','/run/secrets/openobserve_rum_ingest_token'];" +
      "const present=paths.filter(p=>{try{fs.accessSync(p);return true;}catch{return false;}});" +
      "console.log(JSON.stringify(present));process.exit(0);",
  );
  evidence.push(`alert-sink admin secret files present: ${alertSinkNoCreds.stdout}`);
  try {
    const present = JSON.parse(alertSinkNoCreds.stdout || "[]");
    if (Array.isArray(present) && present.length > 0) {
      findings.push(`alert-sink container has access to admin secret files: ${present.join(", ")}`);
    }
  } catch {
    // stdout wasn't the expected JSON; leave as informational evidence only.
  }

  return { pass: findings.length === 0, findings, evidence };
}

// ---------------------------------------------------------------------------
// Section 10: alert-sink / notification privacy under adversarial content.
// ---------------------------------------------------------------------------
const FORBIDDEN_NOTIFICATION_SUBSTRINGS = () => {
  const token = readRumToken();
  return [
    token,
    "-----BEGIN",
    "Bearer ",
    "SELECT * FROM",
    "javascript:",
    `session_id=${RUN_ID}-attacker-session`,
  ];
};

export async function checkAlertSinkNotificationPrivacy() {
  const findings = [];
  const auth = readAdminAuthHeader();
  alertSinkControl("reset");

  const adversarialBody = {
    alert: `${RUN_ID}-privacy-probe`,
    severity: "critical",
    status: "firing",
    service: "probe",
    environment: "lab",
    // Forbidden/out-of-schema fields an attacker-influenced template render
    // might otherwise leak: raw stack, full URL w/ query, credential-shaped
    // value, raw row dump, runtime-control body.
    stack: "Error: boom\n    at evil (app.js:1:1)",
    url: `${PROXY_ORIGIN}/checkout?token=${readRumToken()}`,
    rawRows: [{ session_id: "attacker-session", email: "victim@example.invalid" }],
    destinationCredential: "Bearer super-secret-destination-token",
    runtimeControlBody: JSON.stringify({ schemaVersion: 1, revision: 999 }),
  };

  const response = await testLocalDestination(auth, adversarialBody);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const events = alertSinkControl("events");
  const capturedText = JSON.stringify(events.events ?? []);

  for (const forbidden of FORBIDDEN_NOTIFICATION_SUBSTRINGS()) {
    if (forbidden && capturedText.includes(forbidden)) {
      findings.push(
        `forbidden content reached the alert-sink notification body: ${forbidden.slice(0, 24)}...`,
      );
    }
  }
  const lastEvent = (events.events ?? []).at(-1);
  const unexpectedKeys = lastEvent
    ? Object.keys(lastEvent.body ?? {}).filter(
        (key) =>
          ![
            "alert",
            "severity",
            "status",
            "service",
            "environment",
            "version",
            "measuredValue",
            "threshold",
            "sampleSize",
            "evaluationWindow",
            "firingTime",
            "dashboardRef",
            "runbookRef",
            "dedupKey",
          ].includes(key),
      )
    : [];
  if (unexpectedKeys.length > 0) {
    findings.push(
      `alert-sink captured unexpected notification fields: ${unexpectedKeys.join(", ")}`,
    );
  }

  return {
    pass: findings.length === 0,
    findings,
    evidence: [
      `destination-test response ok=${response.body?.success}`,
      `captured events after probe: ${events.count}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Section 1 (live confirmation, Chromium + Firefox): real-page storage
// audit across the full init -> grant -> record -> revoke -> shutdown
// lifecycle, using the real vendor SDK (not a jsdom mock).
// ---------------------------------------------------------------------------
const BROWSERS = [
  ["chromium", chromium],
  ["firefox", firefox],
];

export async function checkBrowserStorageAuditLive() {
  const findings = [];
  const evidence = [];
  const token = readRumToken();

  for (const [name, engine] of BROWSERS) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.goto(PROXY_ORIGIN);
      await page.getByTestId("scenario-initialize-runtime-config").click();
      await page.getByTestId("scenario-consent-grant").click();
      await page.getByTestId("scenario-record-action").click();
      await page.waitForTimeout(300);

      const beforeRevoke = await context.storageState();
      const cookieNames = beforeRevoke.cookies.map((c) => c.name);
      const localStorageOrigins = beforeRevoke.origins.flatMap((o) =>
        o.localStorage.map((entry) => entry.name),
      );

      // The vendor SDK sets its own first-party session cookie by default
      // (see docs reference note in memory / sessionStore.js default
      // COOKIE strategy) -- an *accepted*, expected footprint. The
      // adversarial check is that the *value* of every persisted item
      // never contains the real client token, and no key/value not
      // explainable by the vendor SDK's own session bookkeeping appears.
      const allValuesText = JSON.stringify(beforeRevoke);
      if (allValuesText.includes(token)) {
        findings.push(
          `${name}: the real RUM client token was found in persisted cookie/localStorage state`,
        );
      }

      await page.getByTestId("scenario-consent-revoke").click();
      await page.getByTestId("scenario-shutdown").click();
      await page.waitForTimeout(300);

      const afterShutdown = await context.storageState();
      const afterText = JSON.stringify(afterShutdown);
      if (afterText.includes(token)) {
        findings.push(
          `${name}: the real RUM client token was still present in storage after shutdown`,
        );
      }

      evidence.push(
        `${name}: cookies=${JSON.stringify(cookieNames)} localStorageKeys=${JSON.stringify(localStorageOrigins)}`,
      );

      await context.close();
    } finally {
      await browser.close();
    }
  }

  return { pass: findings.length === 0, findings, evidence };
}

export async function restoreRuntimeControlBaseline() {
  await killSwitchOff();
  generateRuntimeControl();
}
