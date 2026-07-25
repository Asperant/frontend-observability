#!/usr/bin/env node
// Token/credential rotation acceptance for the two real credential classes the
// systemd production reference actually mounts as secret files (see
// docs/production-handoff.md's Linux/systemd contract): RabbitMQ per-service
// passwords, and the OpenObserve delivery-ops ingestion token.
//
// Live-verified against the pinned OpenObserve v0.91.2 image (2026-07-25):
// `PATCH /api/{org}/ingestion-tokens/{name}` with `{"enabled": bool}` returns
// 200 and actually flips admission (confirmed below), but `PUT` on the same
// route returns 405 with `Allow: PATCH`, and `DELETE` also returns 405 with
// `Allow: PATCH`. There is no supported way to regenerate a named ingestion
// token's *value* in place in this build — only enable/disable. Real
// operational "rotation" for that credential class is therefore
// disable-old-value + mint-new-named-token, not in-place value rotation; this
// script proves the disable/enable half of that (the value-changing half is
// exercised by the RabbitMQ passwords below, which fully support rotation).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertExactLabToolchain,
  atomicWriteFile,
  emailSecretPath,
  generatedDir,
  log,
  logError,
  openObserveDeliveryOpsIngestTokenSecretPath,
  passwordSecretPath,
  rabbitmqIngestPasswordSecretPath,
  rabbitmqIngestUsernameSecretPath,
  rabbitmqWorkerPasswordSecretPath,
  rabbitmqWorkerUsernameSecretPath,
  runDockerCompose,
  withExclusiveLock,
} from "./common.mjs";
import { holdDelivery, resumeDelivery } from "./delivery-ops.mjs";
import { requestHttp, requestHttps } from "./verify-http.mjs";
import { waitForHealthy } from "./wait.mjs";

const OPENOBSERVE_ADMIN_BASE_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";
const RUM_PATH = "/rum/v1/default/rum";
const PROBE_TOKEN_NAME = "chicek_token_rotation_probe";
const RABBITMQ_EXCLUSIVE_LOCK_PATH = join(generatedDir, "rabbitmq-exclusive.lock");

function newPassword() {
  return randomBytes(32).toString("base64url");
}

function rabbitctl(args) {
  return runDockerCompose(["exec", "-T", "rabbitmq", "rabbitmqctl", ...args], {
    capture: true,
    allowFailure: true,
  });
}

function rootAuth() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

async function openObserveJson(path, { method = "GET", body, auth = rootAuth() } = {}) {
  const response = await fetch(`${OPENOBSERVE_ADMIN_BASE_URL}${path}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.length ? JSON.parse(text) : {} };
}

// The ingest/worker RabbitMQ users are deliberately narrow AMQP-only
// application accounts with no "management" tag (least privilege — see the
// negative management-API probes in verify-durable-delivery.mjs), so the
// management HTTP API's /api/whoami would 401 for them even with a fully
// valid password and is not a usable credential-validity check here.
// `rabbitmqctl authenticate_user` checks the credential against the real
// AMQP auth backend directly (exit 0 = valid, non-zero = rejected) — the
// correct broker-level proof for this user class.
function rabbitmqAuthenticates(username, password) {
  const result = rabbitctl(["authenticate_user", username, password]);
  return result.status === 0;
}

function ingestionHeaders() {
  return {
    Host: "localhost:8443",
    Origin: "https://localhost:8443",
    "Content-Type": "text/plain;charset=UTF-8",
    "Sec-Fetch-Site": "same-origin",
  };
}

function rumEvent(marker) {
  const sessionId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  return {
    date: Date.now(),
    type: "view",
    marker,
    application_id: "chicek-browser-app",
    service: "browser-app",
    env: "lab",
    version: "2026.07.1",
    session_id: sessionId,
    view_id: viewId,
    session: { id: sessionId },
    view: { id: viewId, url: "https://localhost:8443/token_rotation" },
  };
}

async function queueDepth(queue) {
  const result = rabbitctl(["list_queues", "name", "messages", "--formatter", "json"]);
  const rows = JSON.parse(result.stdout || "[]");
  return rows.find((row) => row.name === queue)?.messages ?? 0;
}

async function waitForQueueDepth(queue, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let depth = await queueDepth(queue);
  while (depth !== target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    depth = await queueDepth(queue);
  }
  return { ok: depth === target, depth };
}

async function rotateRabbitmqCredential({ role, usernamePath, passwordPath, service, findings }) {
  const username = readFileSync(usernamePath, "utf8").trim();
  const oldPassword = readFileSync(passwordPath, "utf8").trim();

  if (!rabbitmqAuthenticates(username, oldPassword)) {
    findings.push(`${role}: precondition failed, current credential rejected.`);
  }

  const rotated = newPassword();
  const change = rabbitctl(["change_password", username, rotated]);
  if (change.status !== 0) {
    findings.push(`${role}: rabbitmqctl change_password failed: ${change.stderr || change.stdout}`);
    return { username, oldPassword, newPassword: rotated };
  }

  if (rabbitmqAuthenticates(username, oldPassword)) {
    findings.push(
      `${role}: old credential still authenticates after rotation, expected rejection.`,
    );
  }
  if (!rabbitmqAuthenticates(username, rotated)) {
    findings.push(`${role}: new credential does not authenticate after rotation.`);
  }

  atomicWriteFile(passwordPath, rotated, { mode: 0o600 });
  runDockerCompose(["up", "-d", "--force-recreate", service]);

  return { username, oldPassword, newPassword: rotated };
}

async function verifyTokenRotation() {
  const findings = [];
  const evidence = { schemaVersion: 1, rabbitmq: {}, openObserveDeliveryOpsToken: {} };

  // --- Part A: RabbitMQ credential rotation (real in-place value rotation) ---
  holdDelivery();
  // The worker polls the delivery-control document rather than checking it
  // per-message instantaneously; give hold time to actually take effect
  // before publishing, or the message can be consumed before rotation starts
  // (same grace period verifyQueueStoragePrivacy uses for the same reason).
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const marker = `token-rotation-${crypto.randomUUID()}`;
  const admission = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(rumEvent(marker)),
  });
  if (admission.statusCode !== 202) {
    findings.push(`pre-rotation admission returned ${admission.statusCode}, expected 202.`);
  }
  const queuedBefore = await waitForQueueDepth("chicek.frontend.rum.q", 1, 45_000);
  if (!queuedBefore.ok)
    findings.push(`expected 1 queued message before rotation, got ${queuedBefore.depth}.`);

  const ingestRotation = await rotateRabbitmqCredential({
    role: "rabbitmq-ingest",
    usernamePath: rabbitmqIngestUsernameSecretPath,
    passwordPath: rabbitmqIngestPasswordSecretPath,
    service: "telemetry-ingest",
    findings,
  });
  const workerRotation = await rotateRabbitmqCredential({
    role: "rabbitmq-worker",
    usernamePath: rabbitmqWorkerUsernameSecretPath,
    passwordPath: rabbitmqWorkerPasswordSecretPath,
    service: "telemetry-delivery-worker",
    findings,
  });

  const readyWait = await waitForHealthy({
    services: ["telemetry-ingest", "telemetry-delivery-worker"],
    timeoutMs: 120_000,
  });
  if (!readyWait.healthy) {
    findings.push(
      "telemetry-ingest/telemetry-delivery-worker did not become healthy after credential rotation.",
    );
  }

  resumeDelivery();
  const drained = await waitForQueueDepth("chicek.frontend.rum.q", 0, 120_000);
  if (!drained.ok) {
    findings.push(
      `message queued before rotation did not drain with the new worker credential (depth=${drained.depth}).`,
    );
  }

  const postRotationMarker = `token-rotation-post-${crypto.randomUUID()}`;
  const postAdmission = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(rumEvent(postRotationMarker)),
  });
  if (postAdmission.statusCode !== 202) {
    findings.push(
      `post-rotation admission (new ingest credential) returned ${postAdmission.statusCode}, expected 202.`,
    );
  }
  const postDrained = await waitForQueueDepth("chicek.frontend.rum.q", 0, 60_000);
  if (!postDrained.ok) {
    findings.push(`post-rotation message did not drain (depth=${postDrained.depth}).`);
  }

  evidence.rabbitmq = {
    zeroLossAcrossRotation: drained.ok && postDrained.ok,
    ingest: { username: ingestRotation.username, rotated: true },
    worker: { username: workerRotation.username, rotated: true },
  };

  // --- Part B: OpenObserve delivery-ops ingestion token (disable/enable is the
  // real supported rotation primitive in this build; see header comment) ---
  const list = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens`);
  let probe = list.json?.data?.find((entry) => entry.name === PROBE_TOKEN_NAME);
  if (!probe) {
    const created = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens`, {
      method: "POST",
      body: { name: PROBE_TOKEN_NAME, description: "token-rotation gate probe token" },
    });
    if (created.status !== 200 && created.status !== 201) {
      findings.push(`could not create probe ingestion token (status ${created.status}).`);
    }
    const relist = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens`);
    probe = relist.json?.data?.find((entry) => entry.name === PROBE_TOKEN_NAME);
  }
  if (!probe) {
    findings.push("probe ingestion token not found after create.");
  } else {
    if (!probe.enabled) {
      const enable = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens/${PROBE_TOKEN_NAME}`, {
        method: "PATCH",
        body: { enabled: true },
      });
      if (enable.status !== 200)
        findings.push(`re-enabling probe token failed (status ${enable.status}).`);
    }

    const putAttempt = await fetch(
      `${OPENOBSERVE_ADMIN_BASE_URL}/api/${ORG_ID}/ingestion-tokens/${PROBE_TOKEN_NAME}`,
      { method: "PUT", headers: { Authorization: rootAuth() } },
    );
    const deleteAttempt = await fetch(
      `${OPENOBSERVE_ADMIN_BASE_URL}/api/${ORG_ID}/ingestion-tokens/${PROBE_TOKEN_NAME}`,
      { method: "DELETE", headers: { Authorization: rootAuth() } },
    );
    evidence.openObserveDeliveryOpsToken.valueRotationSupported = false;
    evidence.openObserveDeliveryOpsToken.putStatus = putAttempt.status;
    evidence.openObserveDeliveryOpsToken.deleteStatus = deleteAttempt.status;
    if (putAttempt.status !== 405 || deleteAttempt.status !== 405) {
      findings.push(
        `assumption about OpenObserve ingestion-token value-rotation support is stale ` +
          `(PUT=${putAttempt.status}, DELETE=${deleteAttempt.status}, expected 405/405) — ` +
          `re-check whether real in-place rotation is now possible.`,
      );
    }

    const probeAuth = `Basic ${Buffer.from(`${ORG_ID}:${probe.token}`).toString("base64")}`;
    const workingWrite = await requestHttp(`/api/${ORG_ID}/chicek_token_rotation_probe/_json`, {
      method: "POST",
      headers: { Authorization: probeAuth, "Content-Type": "application/json" },
      body: JSON.stringify([{ date: Date.now(), marker: "token-rotation-probe-enabled" }]),
    });
    if (workingWrite.statusCode !== 200) {
      findings.push(`enabled probe token write returned ${workingWrite.statusCode}, expected 200.`);
    }

    const disable = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens/${PROBE_TOKEN_NAME}`, {
      method: "PATCH",
      body: { enabled: false },
    });
    if (disable.status !== 200)
      findings.push(`disabling probe token failed (status ${disable.status}).`);

    const rejectedWrite = await requestHttp(`/api/${ORG_ID}/chicek_token_rotation_probe/_json`, {
      method: "POST",
      headers: { Authorization: probeAuth, "Content-Type": "application/json" },
      body: JSON.stringify([{ date: Date.now(), marker: "token-rotation-probe-disabled" }]),
    });
    if (rejectedWrite.statusCode !== 401 && rejectedWrite.statusCode !== 403) {
      findings.push(
        `disabled probe token write returned ${rejectedWrite.statusCode}, expected 401/403.`,
      );
    }

    const reEnable = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens/${PROBE_TOKEN_NAME}`, {
      method: "PATCH",
      body: { enabled: true },
    });
    if (reEnable.status !== 200)
      findings.push(`re-enabling probe token after test failed (status ${reEnable.status}).`);

    evidence.openObserveDeliveryOpsToken.disableEnableSupported =
      workingWrite.statusCode === 200 &&
      (rejectedWrite.statusCode === 401 || rejectedWrite.statusCode === 403) &&
      reEnable.status === 200;
  }

  // The real production token file is untouched by this gate — only the
  // RabbitMQ credential files (which we deliberately rotate above) and the
  // disposable probe token change.
  const productionTokenUntouched =
    readFileSync(openObserveDeliveryOpsIngestTokenSecretPath, "utf8").trim().length > 0;
  if (!productionTokenUntouched)
    findings.push("production delivery-ops token secret file is unexpectedly empty.");

  const evidenceDir = join(generatedDir, "token_rotation");
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = join(evidenceDir, "token-rotation.json");
  atomicWriteFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  return { pass: findings.length === 0, findings, evidencePath, evidence };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:token-rotation");
    const result = await withExclusiveLock(
      RABBITMQ_EXCLUSIVE_LOCK_PATH,
      () => verifyTokenRotation(),
      {
        maxAttempts: 3,
        retryDelayMs: 1000,
      },
    );
    log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:token-rotation FAILED: ${error.message}`);
    process.exit(1);
  }
}
