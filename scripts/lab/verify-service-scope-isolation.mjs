import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertExactLabToolchain,
  emailSecretPath,
  deliveryControlPath,
  log,
  logError,
  passwordSecretPath,
  repoRoot,
} from "./common.mjs";
import { requestHttp, requestHttps } from "./verify-http.mjs";

const RUM_PATH = "/rum/v1/default/rum";
const CONTROL_PATH = "/observability/control.json";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function openObserveRootAuth() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

function event(marker, service, env) {
  const sessionId = randomUUID();
  const viewId = randomUUID();
  return {
    date: Date.now(),
    type: "view",
    marker,
    service,
    env,
    version: "evil-version",
    session_id: sessionId,
    view_id: viewId,
    session: { id: sessionId },
    view: { id: viewId, url: "https://localhost:8443/scope-isolation?secret=drop#x" },
  };
}

async function postOrigin({ host, origin, marker }) {
  const body = JSON.stringify(event(marker, "attacker-service", "attacker-env"));
  return requestHttps(RUM_PATH, {
    method: "POST",
    headers: {
      Host: host,
      Origin: origin,
      "Content-Type": "text/plain;charset=UTF-8",
      "Sec-Fetch-Site": "same-origin",
      "X-Observability-Service": "attacker-header-service",
      "X-Observability-Environment": "attacker-header-env",
      "X-Observability-Version": "attacker-header-version",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
}

async function searchMarker(marker) {
  const safeMarker = marker.replaceAll("'", "''");
  const nowUs = Date.now() * 1000;
  const response = await requestHttp("/api/default/_search?type=logs", {
    method: "POST",
    headers: {
      Authorization: openObserveRootAuth(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        sql: `select service, env, version, marker from _rumdata where marker = '${safeMarker}' limit 20`,
        start_time: nowUs - 10 * 60 * 1_000_000,
        end_time: nowUs,
      },
    }),
  });
  if (response.statusCode !== 200) {
    throw new Error(`OpenObserve search failed (${response.statusCode})`);
  }
  const parsed = JSON.parse(response.body || "{}");
  return Array.isArray(parsed.hits) ? parsed.hits : [];
}

async function waitForMarker(marker) {
  const deadline = Date.now() + 90_000;
  let rows;
  do {
    rows = await searchMarker(marker);
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  return rows ?? [];
}

async function verifyServiceScopeIsolation() {
  const findings = [];
  const runId = `service-scope-${randomUUID()}`;
  const primaryMarker = `${runId}-primary`;
  const alternateMarker = `${runId}-alternate`;
  const primary = await postOrigin({
    host: "localhost:8443",
    origin: "https://localhost:8443",
    marker: primaryMarker,
  });
  const alternate = await postOrigin({
    host: "127.0.0.1:8443",
    origin: "https://127.0.0.1:8443",
    marker: alternateMarker,
  });
  if (primary.statusCode !== 202) findings.push(`primary origin returned ${primary.statusCode}`);
  if (alternate.statusCode !== 202)
    findings.push(`alternate origin returned ${alternate.statusCode}`);

  const primaryRows = await waitForMarker(primaryMarker);
  const alternateRows = await waitForMarker(alternateMarker);
  if (!primaryRows.some((row) => row.service === "browser-app" && row.env === "lab")) {
    findings.push("primary origin was not canonicalized to browser-app/lab");
  }
  if (!alternateRows.some((row) => row.service === "browser-app-alt" && row.env === "lab")) {
    findings.push("alternate origin was not canonicalized to browser-app-alt/lab");
  }
  const allRows = [...primaryRows, ...alternateRows];
  if (
    allRows.some(
      (row) =>
        row.service === "attacker-service" ||
        row.service === "attacker-header-service" ||
        row.env === "attacker-env" ||
        row.env === "attacker-header-env" ||
        row.version === "attacker-header-version",
    )
  ) {
    findings.push("browser-supplied scope survived canonicalization");
  }

  publishScopedControl("disable", "browser-app", "lab");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const scopedControl = await requestHttps(CONTROL_PATH, {
    headers: { Host: "localhost:8443" },
  });
  const alternateControl = await requestHttps(CONTROL_PATH, {
    headers: { Host: "127.0.0.1:8443" },
  });
  if (JSON.parse(scopedControl.body || "{}")?.killSwitch?.active !== true) {
    findings.push("primary origin did not receive scoped disabled control document");
  }
  if (JSON.parse(alternateControl.body || "{}")?.killSwitch?.active !== false) {
    findings.push("alternate origin was affected by primary scoped disabled control document");
  }
  const blockedPrimary = await postOrigin({
    host: "localhost:8443",
    origin: "https://localhost:8443",
    marker: `${runId}-primary-disabled`,
  });
  const allowedAlternate = await postOrigin({
    host: "127.0.0.1:8443",
    origin: "https://127.0.0.1:8443",
    marker: `${runId}-alternate-enabled`,
  });
  if (blockedPrimary.statusCode === 202) {
    findings.push("primary origin telemetry was accepted while scoped disabled");
  }
  if (allowedAlternate.statusCode !== 202) {
    findings.push(`alternate origin returned ${allowedAlternate.statusCode} during scoped disable`);
  }
  const deliveryControl = JSON.parse(readFileSync(deliveryControlPath, "utf8"));
  if (
    deliveryControl.hold !== true ||
    !deliveryControl.scopedHolds?.some(
      (scope) => scope.service === "browser-app" && scope.environment === "lab",
    )
  ) {
    findings.push("delivery-control did not enter HOLD for scoped disable");
  }
  publishScopedControl("enable", "browser-app", "lab");

  const evidence = {
    schemaVersion: 1,
    runIdHash: sha256(runId),
    primaryMarkerHash: sha256(primaryMarker),
    alternateMarkerHash: sha256(alternateMarker),
    primaryStatus: primary.statusCode,
    alternateStatus: alternate.statusCode,
    primaryRows: primaryRows.length,
    alternateRows: alternateRows.length,
    scopedDisable: {
      primaryControlStatus: scopedControl.statusCode,
      alternateControlStatus: alternateControl.statusCode,
      blockedPrimaryStatus: blockedPrimary.statusCode,
      allowedAlternateStatus: allowedAlternate.statusCode,
      deliveryHeld: deliveryControl.hold === true,
    },
    pass: findings.length === 0,
  };
  mkdirSync(join(repoRoot, "evidence/acceptance"), { recursive: true });
  const evidencePath = join(repoRoot, "evidence/acceptance/service-scope-isolation.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return { pass: findings.length === 0, findings, evidencePath, evidence };
}

function publishScopedControl(command, service, environment) {
  execFileSync(
    "node",
    [
      "scripts/operator/runtime-control.mjs",
      command,
      "--service",
      service,
      "--environment",
      environment,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OBSERVABILITY_DELIVERY_CONTROL_FILE: deliveryControlPath,
      },
      stdio: "ignore",
    },
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("test:service-scope-isolation");
    const result = await verifyServiceScopeIsolation();
    log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:service-scope-isolation FAILED: ${error.message}`);
    process.exit(1);
  }
}
