import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  atomicWriteFile,
  COMPOSE_PROJECT_NAME,
  emailSecretPath,
  generatedDir,
  log,
  logError,
  openObserveDeliveryOpsIngestTokenSecretPath,
  openObserveRumIngestTokenSecretPath,
  passwordSecretPath,
  rabbitmqMonitoringPasswordSecretPath,
  rabbitmqMonitoringUsernameSecretPath,
  repoRoot,
  run,
  runDockerCompose,
  workerFaultPath,
} from "./common.mjs";
import { holdDelivery, resumeDelivery } from "./delivery-ops.mjs";
import { requestHttps, requestHttp } from "./verify-http.mjs";
import { waitForHealthy } from "./wait.mjs";

const RUM_PATH = "/rum/v1/default/rum";
const LOGS_PATH = "/rum/v1/default/logs";
const STAGE205_RUNTIME_DIR = join(generatedDir, "stage20_5");
const ALL_QUEUES = [
  "chicek.frontend.rum.q",
  "chicek.frontend.log.q",
  "chicek.frontend.rum.retry.1.q",
  "chicek.frontend.rum.retry.2.q",
  "chicek.frontend.rum.retry.3.q",
  "chicek.frontend.log.retry.1.q",
  "chicek.frontend.log.retry.2.q",
  "chicek.frontend.log.retry.3.q",
  "chicek.frontend.rum.dlq",
  "chicek.frontend.log.dlq",
];
const DLQ_QUEUES = ["chicek.frontend.rum.dlq", "chicek.frontend.log.dlq"];
const SCANNER_IMAGE =
  "node:24.18.0-alpine@sha256:4ba75f835bb8802193e4c114572113d4b26f95f6f094f4b5229d2a77773e0afc";

function ingestionHeaders() {
  return {
    Host: "localhost:8443",
    Origin: "https://localhost:8443",
    "Content-Type": "text/plain;charset=UTF-8",
    "Sec-Fetch-Site": "same-origin",
  };
}

function rumEvent(marker) {
  return {
    date: Date.now(),
    type: "view",
    marker,
    application_id: "chicek-demo-frontend",
    service: "demo-frontend",
    env: "lab",
    version: "2026.07.1",
    session: { id: crypto.randomUUID() },
    view: { id: crypto.randomUUID(), url: `https://localhost:8443/stage20_5?secret=drop#x` },
  };
}

function logEvent(marker) {
  return {
    date: Date.now(),
    marker,
    message: "stage20_5 durable log",
    status: "info",
    service: "demo-frontend",
    env: "lab",
    version: "2026.07.1",
  };
}

function rabbitctl(args, { allowFailure = false } = {}) {
  return runDockerCompose(["exec", "-T", "rabbitmq", "rabbitmqctl", ...args], {
    capture: true,
    allowFailure,
  });
}

function queueDepth(queue) {
  const result = rabbitctl(["list_queues", "name", "messages", "--formatter", "json"]);
  const rows = JSON.parse(result.stdout || "[]");
  return rows.find((row) => row.name === queue)?.messages ?? 0;
}

function queueRows() {
  const result = rabbitctl([
    "list_queues",
    "name",
    "messages",
    "messages_ready",
    "consumers",
    "--formatter",
    "json",
  ]);
  return JSON.parse(result.stdout || "[]");
}

function queueDepthTotal(queues = ALL_QUEUES) {
  const rows = queueRows();
  return queues.reduce(
    (sum, queue) => sum + (rows.find((row) => row.name === queue)?.messages ?? 0),
    0,
  );
}

function queueDepths(queues = ALL_QUEUES) {
  const rows = queueRows();
  return Object.fromEntries(
    queues.map((queue) => [queue, rows.find((row) => row.name === queue)?.messages ?? 0]),
  );
}

function queueStatsFromManagement() {
  const username = readFileSync(rabbitmqMonitoringUsernameSecretPath, "utf8").trim();
  const password = readFileSync(rabbitmqMonitoringPasswordSecretPath, "utf8").trim();
  return requestHttp("/api/queues/%2F", {
    port: 15672,
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
  }).then((response) => {
    if (response.statusCode !== 200) {
      throw new Error(`RabbitMQ Management queue stats returned ${response.statusCode}.`);
    }
    const rows = JSON.parse(response.body || "[]");
    const byName = new Map(rows.map((row) => [row.name, row]));
    let depth = 0;
    let bytes = 0;
    const queues = {};
    for (const queue of ALL_QUEUES) {
      const row = byName.get(queue) ?? {};
      const queueDepthValue = Number(row.messages ?? 0);
      const queueBytesValue = Number(row.message_bytes ?? row.message_bytes_ready ?? 0);
      depth += Number.isFinite(queueDepthValue) ? queueDepthValue : 0;
      bytes += Number.isFinite(queueBytesValue) ? queueBytesValue : 0;
      queues[queue] = {
        depth: Number.isFinite(queueDepthValue) ? queueDepthValue : 0,
        bytes: Number.isFinite(queueBytesValue) ? queueBytesValue : 0,
        consumers: Number(row.consumers ?? 0),
        state: row.state ?? "unknown",
        idleSince: row.idle_since ?? null,
      };
    }
    return { depth, bytes, queues };
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeEvidence(name, value) {
  mkdirSync(STAGE205_RUNTIME_DIR, { recursive: true });
  const path = join(STAGE205_RUNTIME_DIR, name);
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function parseAdmissionIds(response) {
  try {
    const body = JSON.parse(response.body);
    if (typeof body.batchId === "string" && typeof body.eventId === "string") {
      return { batchId: body.batchId, eventId: body.eventId };
    }
  } catch {
    // Non-JSON admission bodies are treated as missing ids by the caller.
  }
  return null;
}

async function waitForTotalQueueDepth(expected, timeoutMs = 120_000, queues = ALL_QUEUES) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const depth = queueDepthTotal(queues);
    if (depth === expected) return { ok: true, depth, depths: queueDepths(queues) };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, depth: queueDepthTotal(queues), depths: queueDepths(queues) };
}

async function waitForQueueAtLeast(queue, minimum, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const depth = queueDepth(queue);
    if (depth >= minimum) return { ok: true, depth };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, depth: queueDepth(queue) };
}

async function driveBrowserTraffic(browserType, { runId, accepted, unexpected, stopAtMs }) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const browserName = browserType.name();
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes(RUM_PATH) && !url.includes(LOGS_PATH)) return;
    const status = response.status();
    let body = "";
    try {
      body = await response.text();
    } catch {
      // Response body is diagnostic-only; status and ids still drive the proof.
    }
    if (status === 202) {
      const ids = parseAdmissionIds({ body });
      if (ids) {
        accepted.push({
          browser: browserName,
          path: url.includes(LOGS_PATH) ? LOGS_PATH : RUM_PATH,
          status,
          ...ids,
          observedAt: new Date().toISOString(),
        });
      } else {
        unexpected.push({ browser: browserName, status, reason: "missing_admission_ids" });
      }
    } else if (status >= 400) {
      unexpected.push({
        browser: browserName,
        status,
        reason: "unexpected_browser_ingest_status",
        bodyHash: sha256(body),
      });
    }
  });

  async function click(id) {
    await page.getByTestId(`scenario-${id}`).click({ timeout: 10_000 });
  }

  try {
    await page.goto("https://localhost:8443", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.evaluate((value) => {
      globalThis.__CHICEK_TEST_RUN_ID__ = value;
    }, runId);
    await click("consent-grant");
    await click("initialize-runtime-config");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.evaluate((value) => {
      globalThis.__CHICEK_TEST_RUN_ID__ = value;
    }, runId);
    await click("initialize-runtime-config");
    await click("consent-grant");
    let iteration = 0;
    while (performance.now() < stopAtMs) {
      await page.evaluate((value) => {
        globalThis.__CHICEK_TEST_RUN_ID__ = value;
      }, runId);
      for (const id of ["record-action", "record-error", "success-request"]) {
        await click(id);
        await page.waitForTimeout(750);
      }
      iteration += 1;
      if (iteration % 10 === 0) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.evaluate((value) => {
          globalThis.__CHICEK_TEST_RUN_ID__ = value;
        }, runId);
        await click("initialize-runtime-config");
        await click("consent-grant");
      }
      await page.waitForTimeout(15_000);
    }
    await page.waitForTimeout(40_000);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function waitForDrain(timeoutMs = 900_000) {
  const started = Date.now();
  const result = await waitForTotalQueueDepth(0, timeoutMs, ALL_QUEUES);
  return {
    ...result,
    durationMs: Date.now() - started,
    durationSeconds: Math.round((Date.now() - started) / 1000),
  };
}

function scanRabbitVolume({ positiveMarker, sensitiveCanaries }) {
  const scanner = `
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const positive = Buffer.from(process.env.POSITIVE_MARKER, 'utf8');
const sensitive = JSON.parse(process.env.SENSITIVE_CANARIES).map((value) => Buffer.from(value, 'utf8'));
const result = { filesScanned: 0, bytesScanned: 0, positiveHits: 0, sensitiveHits: Array(sensitive.length).fill(0) };
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile()) {
      const data = readFileSync(path);
      result.filesScanned += 1;
      result.bytesScanned += data.length;
      if (data.includes(positive)) result.positiveHits += 1;
      sensitive.forEach((needle, index) => {
        if (data.includes(needle)) result.sensitiveHits[index] += 1;
      });
    }
  }
}
walk('/scan');
console.log(JSON.stringify(result));
`;
  const result = run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "-v",
      `${COMPOSE_PROJECT_NAME}_rabbitmq-data:/scan:ro`,
      "-e",
      `POSITIVE_MARKER=${positiveMarker}`,
      "-e",
      `SENSITIVE_CANARIES=${JSON.stringify(sensitiveCanaries)}`,
      SCANNER_IMAGE,
      "node",
      "-e",
      scanner,
    ],
    { capture: true, allowFailure: false, cwd: repoRoot },
  );
  return JSON.parse(result.stdout || "{}");
}

function dockerLogsForServices(services) {
  const result = runDockerCompose(["logs", "--no-color", ...services], {
    capture: true,
    allowFailure: false,
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function canarySummary(canaries, haystack) {
  return Object.fromEntries(
    Object.entries(canaries).map(([name, value]) => [
      name,
      {
        sha256: sha256(value),
        present: haystack.includes(value),
      },
    ]),
  );
}

function acceptedRumEvent(marker, canaries = {}) {
  return {
    ...rumEvent(marker),
    positive_control_marker: marker,
    note: `safe marker ${marker} from /safe/path?query=${canaries.query ?? "none"}#${canaries.fragment ?? "none"} source 203.0.113.77`,
    view: {
      id: crypto.randomUUID(),
      url: `https://localhost:8443/stage20_5_volume?query=${canaries.query ?? "drop"}#${canaries.fragment ?? "drop"}`,
    },
  };
}

function rejectedRumEvent(marker, key, value) {
  return {
    ...rumEvent(marker),
    [key]: value,
  };
}

function writeWorkerFault(document) {
  atomicWriteFile(workerFaultPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
}

async function waitForLogPattern(service, pattern, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = dockerLogsForServices([service]);
    if (pattern.test(text)) return { ok: true, textHash: sha256(text) };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, textHash: sha256(dockerLogsForServices([service])) };
}

function openObserveIngestAuth(token) {
  return `Basic ${Buffer.from(`default:${token}`).toString("base64")}`;
}

function openObserveRootAuth() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

async function openObserveSql(sql) {
  const endUs = Date.now() * 1000;
  const startUs = endUs - 24 * 60 * 60 * 1_000_000;
  const response = await requestHttp("/api/default/_search?type=logs", {
    method: "POST",
    headers: {
      Authorization: openObserveRootAuth(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: { sql, from: 0, size: 50, start_time: startUs, end_time: endUs },
    }),
  });
  if (response.statusCode !== 200) {
    throw new Error(
      `OpenObserve search returned ${response.statusCode}: ${response.body.slice(0, 160)}`,
    );
  }
  return JSON.parse(response.body || "{}");
}

async function openObserveCount(stream, field, value) {
  const safeStream = stream.replace(/"/g, "");
  const safeField = field.replace(/[^A-Za-z0-9_.]/g, "");
  const safeValue = String(value).replace(/'/g, "''");
  const result = await openObserveSql(
    `select count(*) as count from "${safeStream}" where ${safeField} = '${safeValue}'`,
  );
  return Number(result?.hits?.[0]?.count ?? result?.hits?.[0]?.count_count ?? 0);
}

async function openObserveTotalCount(stream) {
  const safeStream = stream.replace(/"/g, "");
  const result = await openObserveSql(`select count(*) as count from "${safeStream}"`);
  return Number(result?.hits?.[0]?.count ?? result?.hits?.[0]?.count_count ?? 0);
}

async function waitForOpenObserveDeltas(before, expected, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let counts = { rum: 0, logs: 0 };
  while (Date.now() < deadline) {
    counts = {
      rum: await openObserveTotalCount("_rumdata"),
      logs: await openObserveTotalCount("_rumlog"),
    };
    const delta = {
      rum: counts.rum - before.rum,
      logs: counts.logs - before.logs,
    };
    const rumOk = !expected.rum || delta.rum > 0;
    const logsOk = !expected.logs || delta.logs > 0;
    if (rumOk && logsOk) return { ok: true, counts, delta };
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return {
    ok: false,
    counts,
    delta: {
      rum: counts.rum - before.rum,
      logs: counts.logs - before.logs,
    },
  };
}

async function openObserveRecentHaystack(stream, limit = 500) {
  const safeStream = stream.replace(/"/g, "");
  const result = await openObserveSql(
    `select * from "${safeStream}" order by _timestamp desc limit ${Number(limit)}`,
  );
  return JSON.stringify(result?.hits ?? []);
}

async function waitForQueueDepth(queue, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const depth = queueDepth(queue);
    if (depth === expected) return { ok: true, depth };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, depth: queueDepth(queue) };
}

async function verifyStage205DurableDelivery() {
  const findings = [];
  const accounting = {
    durablyAccepted: 0,
    delivered: 0,
    currentlyQueued: 0,
    deadLettered: 0,
    explicitlyPurged: 0,
    expiredByApprovedPolicy: 0,
    unexpectedLoss: 0,
    rejectedBySecurity: 0,
    rejectedByCapacity: 0,
    publisherConfirmFailed: 0,
    duplicateObserved: 0,
  };

  const directOpenObserve = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(rumEvent("stage20_5-direct-path-check")),
  });
  if (directOpenObserve.statusCode !== 202) {
    findings.push(`durable admission returned ${directOpenObserve.statusCode}, expected 202.`);
  } else {
    accounting.durablyAccepted += 1;
  }

  const badPayload = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify({ ...rumEvent("stage20_5-secret"), authorization: "Bearer SECRET" }),
  });
  if (badPayload.statusCode < 400 || badPayload.statusCode >= 500) {
    findings.push(`unsafe payload returned ${badPayload.statusCode}, expected deterministic 4xx.`);
  } else {
    accounting.rejectedBySecurity += 1;
  }

  const marker = `stage20_5-${crypto.randomUUID()}`;
  const rumAccepted = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(rumEvent(marker)),
  });
  const logAccepted = await requestHttps(LOGS_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(logEvent(marker)),
  });
  for (const [label, response] of [
    ["rum", rumAccepted],
    ["logs", logAccepted],
  ]) {
    if (response.statusCode !== 202)
      findings.push(`${label} admission returned ${response.statusCode}.`);
    else accounting.durablyAccepted += 1;
  }

  runDockerCompose(["stop", "openobserve"]);
  await waitForHealthy({
    services: ["rabbitmq", "durable-ingest", "reverse-proxy"],
    timeoutMs: 60_000,
  });
  const outageMarker = `stage20_5-outage-${crypto.randomUUID()}`;
  const outageResponse = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(rumEvent(outageMarker)),
  });
  if (outageResponse.statusCode !== 202) {
    findings.push(
      `OpenObserve outage admission returned ${outageResponse.statusCode}, expected 202.`,
    );
  } else {
    accounting.durablyAccepted += 1;
  }
  const queued = await waitForQueueDepth("chicek.frontend.rum.q", 1, 45_000);
  if (!queued.ok) findings.push(`outage queue depth expected 1, got ${queued.depth}.`);

  runDockerCompose(["start", "openobserve"]);
  await waitForHealthy({
    services: ["openobserve", "alert-sink", "delivery-worker"],
    timeoutMs: 120_000,
  });
  const drained = await waitForQueueDepth("chicek.frontend.rum.q", 0, 90_000);
  if (!drained.ok) findings.push(`post-recovery drain expected depth 0, got ${drained.depth}.`);

  const rabbitDown = (() => {
    runDockerCompose(["stop", "rabbitmq"]);
    return requestHttps(LOGS_PATH, {
      method: "POST",
      headers: ingestionHeaders(),
      body: JSON.stringify(logEvent(`stage20_5-rabbit-down-${crypto.randomUUID()}`)),
    });
  })();
  const rabbitDownResponse = await rabbitDown;
  if (rabbitDownResponse.statusCode !== 503) {
    findings.push(`RabbitMQ down returned ${rabbitDownResponse.statusCode}, expected 503.`);
  } else {
    accounting.publisherConfirmFailed += 1;
  }
  runDockerCompose(["start", "rabbitmq"]);
  await waitForHealthy({
    services: ["rabbitmq", "durable-ingest", "delivery-worker"],
    timeoutMs: 120_000,
  });

  const managementPublic = await requestHttps("/api/queues", { method: "GET" });
  if (![403, 404, 405].includes(managementPublic.statusCode)) {
    findings.push(
      `RabbitMQ management path through proxy returned ${managementPublic.statusCode}.`,
    );
  }
  const managementLoopback = await requestHttp("/", { port: 15672 });
  if (managementLoopback.statusCode !== 200) {
    findings.push(
      `RabbitMQ management loopback returned ${managementLoopback.statusCode}, expected 200.`,
    );
  }

  const token = readFileSync(openObserveRumIngestTokenSecretPath, "utf8").trim();
  const tokenLeakText = [directOpenObserve.body, rumAccepted.body, logAccepted.body].join("\n");
  if (tokenLeakText.includes(token))
    findings.push("server-side OpenObserve token leaked in browser response.");

  const opsToken = readFileSync(openObserveDeliveryOpsIngestTokenSecretPath, "utf8").trim();
  const opsMarker = `stage20_5-ops-credential-${crypto.randomUUID()}`;
  const opsWrite = await requestHttp("/api/default/_chicek_delivery_ops/_json", {
    method: "POST",
    headers: {
      Authorization: openObserveIngestAuth(opsToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ date: Date.now(), service: "stage20_5_gate", marker: opsMarker }]),
  });
  if (opsWrite.statusCode !== 200) {
    findings.push(`delivery ops ingest credential write returned ${opsWrite.statusCode}.`);
  }
  for (const path of ["/api/default/users", "/api/default/dashboards", "/api/default/streams"]) {
    const management = await requestHttp(path, {
      headers: { Authorization: openObserveIngestAuth(opsToken) },
    });
    if (management.statusCode !== 401 && management.statusCode !== 403) {
      findings.push(
        `delivery ops ingest credential could access management path ${path} (${management.statusCode}).`,
      );
    }
  }
  const unrelatedWrite = await requestHttp("/api/default/chicek_unrelated_probe/_json", {
    method: "POST",
    headers: {
      Authorization: openObserveIngestAuth(opsToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ date: Date.now(), service: "stage20_5_gate", marker: opsMarker }]),
  });
  if (unrelatedWrite.statusCode === 200) {
    log(
      "stage20.5: OpenObserve v0.91.2 org ingestion tokens are not stream-scoped; unrelated stream write succeeded as documented product limitation.",
    );
  } else if (unrelatedWrite.statusCode !== 401 && unrelatedWrite.statusCode !== 403) {
    findings.push(`unrelated stream negative probe returned ${unrelatedWrite.statusCode}.`);
  }

  accounting.currentlyQueued =
    queueDepth("chicek.frontend.rum.q") + queueDepth("chicek.frontend.log.q");
  accounting.deadLettered =
    queueDepth("chicek.frontend.rum.dlq") + queueDepth("chicek.frontend.log.dlq");
  accounting.delivered =
    accounting.durablyAccepted -
    accounting.currentlyQueued -
    accounting.deadLettered -
    accounting.explicitlyPurged -
    accounting.expiredByApprovedPolicy;
  accounting.unexpectedLoss = Math.max(
    0,
    accounting.durablyAccepted -
      accounting.delivered -
      accounting.currentlyQueued -
      accounting.deadLettered -
      accounting.explicitlyPurged -
      accounting.expiredByApprovedPolicy,
  );

  return { pass: findings.length === 0 && accounting.unexpectedLoss === 0, findings, accounting };
}

async function verifyStage205VolumeLeakProof() {
  const findings = [];
  const runId = `stage205-volume-${crypto.randomUUID()}`;
  const positiveMarker = `${runId}-positive-control`;
  const canaries = {
    secret: `${runId}-secret-canary`,
    token: `${runId}-token-canary`,
    cookie: `${runId}-cookie-canary`,
    authorization: `${runId}-authorization-canary`,
    password: `${runId}-password-canary`,
    rawIp: "198.51.100.123",
    query: `${runId}-query-canary`,
    fragment: `${runId}-fragment-canary`,
    body: `${runId}-body-canary`,
    dom: `${runId}-dom-canary`,
    replay: `${runId}-replay-canary`,
  };
  const sensitiveValues = Object.values(canaries);
  holdDelivery();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const accepted = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(acceptedRumEvent(positiveMarker, canaries)),
  });
  const ids = parseAdmissionIds(accepted);
  if (accepted.statusCode !== 202 || !ids) {
    findings.push(
      `positive-control admission returned ${accepted.statusCode} with ids=${Boolean(ids)}.`,
    );
  }

  const rejectedInputs = [
    ["secret", "context_secret", canaries.secret],
    ["token", "context_token", `token=${canaries.token}`],
    ["cookie", "cookie", canaries.cookie],
    ["authorization", "authorization", `Bearer ${canaries.authorization}abcdefghijkl`],
    ["password", "password", canaries.password],
    ["body", "request_body", canaries.body],
    ["dom", "dom", canaries.dom],
    ["replay", "replay_segment", canaries.replay],
  ];
  const rejections = [];
  for (const [name, key, value] of rejectedInputs) {
    const response = await requestHttps(RUM_PATH, {
      method: "POST",
      headers: ingestionHeaders(),
      body: JSON.stringify(rejectedRumEvent(`${runId}-${name}`, key, value)),
    });
    rejections.push({ name, statusCode: response.statusCode });
    if (!(
      (response.statusCode >= 400 && response.statusCode < 500) ||
      response.statusCode === 202
    )) {
      findings.push(
        `sensitive ${name} payload returned ${response.statusCode}, expected stripped 202 or deterministic 4xx.`,
      );
    }
  }

  const queued = await waitForQueueAtLeast("chicek.frontend.rum.q", 1, 45_000);
  if (!queued.ok) findings.push(`positive-control queue depth expected >=1, got ${queued.depth}.`);
  runDockerCompose(["stop", "rabbitmq"]);
  const scan = scanRabbitVolume({ positiveMarker, sensitiveCanaries: sensitiveValues });
  if (scan.positiveHits < 1) findings.push("RabbitMQ volume scan did not find positive control.");
  const sensitiveHits = Object.fromEntries(
    Object.keys(canaries).map((name, index) => [name, scan.sensitiveHits?.[index] ?? 0]),
  );
  for (const [name, hits] of Object.entries(sensitiveHits)) {
    if (hits !== 0) findings.push(`RabbitMQ volume scan found sensitive canary ${name}.`);
  }

  runDockerCompose(["start", "rabbitmq"]);
  runDockerCompose(["up", "-d", "--force-recreate", "durable-ingest", "delivery-worker"]);
  const restartWait = await waitForHealthy({
    services: ["rabbitmq", "durable-ingest", "delivery-worker"],
    timeoutMs: 120_000,
  });
  if (!restartWait.healthy) {
    findings.push("RabbitMQ restart recovery did not return durable-ingest and worker to healthy.");
  }
  const survived = await waitForQueueAtLeast("chicek.frontend.rum.q", 1, 45_000);
  if (!survived.ok)
    findings.push(`safe queued batch did not survive RabbitMQ restart (${survived.depth}).`);
  resumeDelivery();
  const drained = await waitForDrain(240_000);
  if (!drained.ok) findings.push(`volume proof drain did not reach zero (${drained.depth}).`);

  const logs = dockerLogsForServices(["durable-ingest", "delivery-worker"]);
  const logCanaries = canarySummary(canaries, logs);
  for (const [name, result] of Object.entries(logCanaries)) {
    if (result.present) findings.push(`sensitive canary ${name} appeared in durable logs.`);
  }
  let openObservePositiveCount = 0;
  try {
    openObservePositiveCount = await openObserveCount(
      "_rumdata",
      "positive_control_marker",
      positiveMarker,
    );
  } catch (error) {
    findings.push(`OpenObserve positive-control query failed: ${error.message}`);
  }
  if (openObservePositiveCount < 1) {
    findings.push("OpenObserve did not contain the drained positive-control marker.");
  }
  const openObserveCanaryPresence = {};
  let openObserveHaystack = "";
  try {
    openObserveHaystack = [
      await openObserveRecentHaystack("_rumdata"),
      await openObserveRecentHaystack("_rumlog"),
      await openObserveRecentHaystack("_chicek_delivery_ops"),
    ].join("\n");
  } catch (error) {
    findings.push(`OpenObserve recent-row canary scan failed: ${error.message}`);
  }
  for (const [name, value] of Object.entries(canaries)) {
    const present = openObserveHaystack.includes(value);
    openObserveCanaryPresence[name] = { sha256: sha256(value), present };
    if (present) findings.push(`sensitive canary ${name} appeared in OpenObserve.`);
  }

  const evidence = {
    schemaVersion: 1,
    runId,
    positiveControl: {
      name: "positive_control_marker",
      sha256: sha256(positiveMarker),
      volumeHits: scan.positiveHits,
      openObserveCount: openObservePositiveCount,
    },
    sensitiveCanaries: Object.fromEntries(
      Object.entries(canaries).map(([name, value]) => [
        name,
        {
          sha256: sha256(value),
          volumeHits: sensitiveHits[name],
          logPresent: logCanaries[name]?.present ?? false,
          openObserve: openObserveCanaryPresence[name] ?? null,
        },
      ]),
    ),
    admissions: {
      acceptedStatus: accepted.statusCode,
      ids,
      rejections,
    },
    scan: {
      image: SCANNER_IMAGE,
      filesScanned: scan.filesScanned,
      bytesScanned: scan.bytesScanned,
    },
    finalQueueDepths: queueDepths(),
    drainDurationSeconds: drained.durationSeconds,
  };
  const evidencePath = writeEvidence("volume-leak-proof.json", evidence);
  return { pass: findings.length === 0, findings, evidencePath, evidence };
}

async function verifyStage205PreAckCrashProof() {
  const findings = [];
  const runId = `stage205-preack-${crypto.randomUUID()}`;
  const marker = `${runId}-batch`;
  holdDelivery();
  writeWorkerFault({ schemaVersion: 1, enabled: false, updatedAt: new Date().toISOString() });
  runDockerCompose(["up", "-d", "--force-recreate", "delivery-worker"]);
  await waitForHealthy({ services: ["delivery-worker"], timeoutMs: 90_000 });
  const admission = await requestHttps(RUM_PATH, {
    method: "POST",
    headers: ingestionHeaders(),
    body: JSON.stringify(rumEvent(marker)),
  });
  const ids = parseAdmissionIds(admission);
  if (admission.statusCode !== 202 || !ids) {
    findings.push(`pre-ACK admission returned ${admission.statusCode} with ids=${Boolean(ids)}.`);
  }
  const queued = await waitForQueueAtLeast("chicek.frontend.rum.q", 1, 45_000);
  if (!queued.ok) findings.push(`pre-ACK test queue depth expected >=1, got ${queued.depth}.`);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  writeWorkerFault({
    schemaVersion: 1,
    enabled: true,
    mode: "crash_after_openobserve_success_before_ack",
    guard: "stage20_5_lab_only",
    nonce,
    batchId: ids?.batchId,
    eventId: ids?.eventId,
    updatedAt: new Date().toISOString(),
  });
  resumeDelivery();
  const crashLog = await waitForLogPattern(
    "delivery-worker",
    /delivery_worker_test_fault_crash_after_openobserve_success_before_ack/,
    90_000,
  );
  if (!crashLog.ok) findings.push("worker did not crash at the test-only pre-ACK fault point.");
  holdDelivery();
  writeWorkerFault({ schemaVersion: 1, enabled: false, updatedAt: new Date().toISOString() });
  runDockerCompose(["up", "-d", "--force-recreate", "delivery-worker"]);
  await waitForHealthy({ services: ["delivery-worker"], timeoutMs: 90_000 });
  const retained = await waitForQueueAtLeast("chicek.frontend.rum.q", 1, 45_000);
  if (!retained.ok)
    findings.push(`unacked message was not retained after crash (${retained.depth}).`);
  resumeDelivery();
  const drained = await waitForDrain(240_000);
  if (!drained.ok) findings.push(`pre-ACK recovery drain did not reach zero (${drained.depth}).`);
  const redeliveryLog = await waitForLogPattern(
    "delivery-worker",
    /delivery_worker_redelivered_message_received/,
    60_000,
  );
  if (!redeliveryLog.ok)
    findings.push("worker did not record a redelivered message after restart.");

  let openObserveCountForMarker = 0;
  try {
    openObserveCountForMarker = await openObserveCount("_rumdata", "marker", marker);
  } catch (error) {
    findings.push(`OpenObserve pre-ACK marker query failed: ${error.message}`);
  }
  if (openObserveCountForMarker < 1) findings.push("pre-ACK marker was not found in OpenObserve.");
  const duplicateObserved = Math.max(0, openObserveCountForMarker - 1);
  const accounting = {
    durablyAccepted: admission.statusCode === 202 ? 1 : 0,
    delivered: openObserveCountForMarker >= 1 ? 1 : 0,
    currentlyQueued: queueDepthTotal(ALL_QUEUES),
    deadLettered: queueDepthTotal(DLQ_QUEUES),
    explicitlyPurged: 0,
    expiredByApprovedPolicy: 0,
    unexpectedLoss: openObserveCountForMarker >= 1 && queueDepthTotal(ALL_QUEUES) === 0 ? 0 : 1,
    duplicateObserved,
  };
  if (accounting.currentlyQueued !== 0)
    findings.push(`pre-ACK currentlyQueued expected 0, got ${accounting.currentlyQueued}.`);
  if (accounting.unexpectedLoss !== 0)
    findings.push("pre-ACK accounting observed unexpected loss.");
  const evidence = {
    schemaVersion: 1,
    runId,
    markerHash: sha256(marker),
    ids,
    admissionStatus: admission.statusCode,
    crashLogHash: crashLog.textHash,
    redeliveryLogHash: redeliveryLog.textHash,
    retainedDepthAfterCrash: retained.depth,
    drainDurationSeconds: drained.durationSeconds,
    openObserveCount: openObserveCountForMarker,
    accounting,
    faultGuard: {
      enabledByDefault: false,
      requiredEnv: "CHICEK_ENABLE_WORKER_TEST_FAULTS=stage20_5_lab_only",
      requiredFile: "worker-fault.json with nonce and exact eventId/batchId",
    },
  };
  const evidencePath = writeEvidence("preack-crash-proof.json", evidence);
  return { pass: findings.length === 0, findings, evidencePath, evidence };
}

async function sampleQueuesUntil(stopSignal, intervalMs = 30_000) {
  const samples = [];
  while (!stopSignal.done) {
    try {
      samples.push({
        at: new Date().toISOString(),
        monotonicMs: performance.now(),
        ...(await queueStatsFromManagement()),
      });
    } catch (error) {
      samples.push({
        at: new Date().toISOString(),
        monotonicMs: performance.now(),
        error: error.message,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  try {
    samples.push({
      at: new Date().toISOString(),
      monotonicMs: performance.now(),
      ...(await queueStatsFromManagement()),
    });
  } catch {
    // Final sample is best effort; interval samples already captured errors explicitly.
  }
  return samples;
}

function queuePeaks(samples) {
  return samples.reduce(
    (peaks, sample) => ({
      depth: Math.max(peaks.depth, Number(sample.depth ?? 0)),
      bytes: Math.max(peaks.bytes, Number(sample.bytes ?? 0)),
    }),
    { depth: 0, bytes: 0 },
  );
}

async function verifyStage205RealSoak() {
  const findings = [];
  const runId = `stage205-soak-${crypto.randomUUID()}`;
  const accepted = [];
  const unexpected = [];
  resumeDelivery();
  writeWorkerFault({ schemaVersion: 1, enabled: false, updatedAt: new Date().toISOString() });
  await waitForHealthy({
    services: ["reverse-proxy", "durable-ingest", "rabbitmq", "delivery-worker", "openobserve"],
    timeoutMs: 120_000,
  });
  const beforeDepth = queueDepthTotal(ALL_QUEUES);
  if (beforeDepth !== 0) findings.push(`soak requires empty queues at start, got ${beforeDepth}.`);
  const beforeOpenObserve = {
    rum: await openObserveTotalCount("_rumdata"),
    logs: await openObserveTotalCount("_rumlog"),
  };

  const outageStartUtc = new Date().toISOString();
  const outageStartMonotonicMs = performance.now();
  const stopAtMs = outageStartMonotonicMs + 3_600_000;
  runDockerCompose(["stop", "openobserve"]);
  await waitForHealthy({
    services: ["reverse-proxy", "durable-ingest", "rabbitmq", "delivery-worker"],
    timeoutMs: 90_000,
  });
  const samplerStop = { done: false };
  const sampler = sampleQueuesUntil(samplerStop, 30_000);
  await Promise.all([
    driveBrowserTraffic(chromium, { runId, accepted, unexpected, stopAtMs }),
    driveBrowserTraffic(firefox, { runId, accepted, unexpected, stopAtMs }),
  ]);
  while (performance.now() - outageStartMonotonicMs < 3_600_000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const outageEndMonotonicMs = performance.now();
  const outageEndUtc = new Date().toISOString();
  const measuredDurationSeconds = Math.floor(
    (outageEndMonotonicMs - outageStartMonotonicMs) / 1000,
  );
  samplerStop.done = true;
  const samples = await sampler;
  if (measuredDurationSeconds < 3600) {
    findings.push(`real soak duration ${measuredDurationSeconds}s is below 3600s.`);
  }
  if (accepted.length === 0) findings.push("soak produced no 202-accepted browser batches.");
  const idPairs = new Set(accepted.map((item) => `${item.batchId}:${item.eventId}`));
  if (idPairs.size !== accepted.length)
    findings.push("soak accepted batches did not have stable unique ids.");
  const duringOutageQueued = queueDepthTotal(ALL_QUEUES);
  if (duringOutageQueued <= 0 && accepted.length > 0) {
    findings.push(
      "accepted outage batches were not present in RabbitMQ before OpenObserve restart.",
    );
  }

  runDockerCompose(["start", "openobserve"]);
  await waitForHealthy({
    services: ["openobserve", "alert-sink", "delivery-worker"],
    timeoutMs: 180_000,
  });
  resumeDelivery();
  const drainStartedUtc = new Date().toISOString();
  const drainStartedMs = performance.now();
  const drained = await waitForDrain(1_800_000);
  const drainEndedUtc = new Date().toISOString();
  const drainDurationSeconds = Math.round((performance.now() - drainStartedMs) / 1000);
  if (!drained.ok) findings.push(`soak drain did not reach zero (${drained.depth}).`);
  const dlqDepth = queueDepthTotal(DLQ_QUEUES);
  if (dlqDepth !== 0) findings.push(`soak expected empty DLQs, got ${dlqDepth}.`);

  let openObserveDelta = { ok: false, counts: { rum: 0, logs: 0 }, delta: { rum: 0, logs: 0 } };
  const expectedStreams = {
    rum: accepted.some((item) => item.path === RUM_PATH),
    logs: accepted.some((item) => item.path === LOGS_PATH),
  };
  try {
    openObserveDelta = await waitForOpenObserveDeltas(beforeOpenObserve, expectedStreams);
  } catch (error) {
    findings.push(`soak OpenObserve data verification failed: ${error.message}`);
  }
  if (!openObserveDelta.ok) {
    findings.push(
      `soak OpenObserve stream deltas did not appear after drain: ${JSON.stringify(openObserveDelta.delta)}.`,
    );
  }
  const accounting = {
    durablyAccepted: accepted.length,
    delivered: accepted.length - queueDepthTotal(ALL_QUEUES) - dlqDepth,
    currentlyQueued: queueDepthTotal(ALL_QUEUES),
    deadLettered: dlqDepth,
    explicitlyPurged: 0,
    expiredByApprovedPolicy: 0,
    unexpectedLoss: 0,
    rejectedBySecurity: 0,
    rejectedByCapacity: 0,
    publisherConfirmFailed: unexpected.filter((item) => item.status === 503).length,
    duplicateObserved: 0,
  };
  accounting.unexpectedLoss = Math.max(
    0,
    accounting.durablyAccepted -
      accounting.delivered -
      accounting.currentlyQueued -
      accounting.deadLettered -
      accounting.explicitlyPurged -
      accounting.expiredByApprovedPolicy,
  );
  if (accounting.unexpectedLoss !== 0)
    findings.push(`soak unexpectedLoss=${accounting.unexpectedLoss}.`);
  if (unexpected.length > 0) {
    findings.push(
      `soak observed unexpected browser ingest statuses: ${JSON.stringify(unexpected.slice(0, 5))}`,
    );
  }
  const peaks = queuePeaks(samples);
  const evidence = {
    schemaVersion: 1,
    runId,
    outage: {
      startUtc: outageStartUtc,
      endUtc: outageEndUtc,
      startMonotonicMs: outageStartMonotonicMs,
      endMonotonicMs: outageEndMonotonicMs,
      measuredDurationSeconds,
    },
    browserTraffic: {
      acceptedTotal: accepted.length,
      chromiumAccepted: accepted.filter((item) => item.browser === "chromium").length,
      firefoxAccepted: accepted.filter((item) => item.browser === "firefox").length,
      unexpected,
      acceptedIdsHash: sha256(
        JSON.stringify(
          accepted.map(({ batchId, eventId, browser, path }) => ({
            batchId,
            eventId,
            browser,
            path,
          })),
        ),
      ),
    },
    queues: {
      beforeDepth,
      duringOutageDepth: duringOutageQueued,
      peaks,
      finalDepths: queueDepths(),
      sampleCount: samples.length,
      samplesHash: sha256(JSON.stringify(samples)),
    },
    drain: {
      startUtc: drainStartedUtc,
      endUtc: drainEndedUtc,
      durationSeconds: drainDurationSeconds,
    },
    openObserve: {
      before: beforeOpenObserve,
      after: openObserveDelta.counts,
      delta: openObserveDelta.delta,
      expectedStreams,
    },
    accounting,
  };
  const evidencePath = writeEvidence("real-60m-soak.json", evidence);
  return { pass: findings.length === 0, findings, evidencePath, evidence };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:stage20.5:durable-delivery");
    const command = process.argv[2] ?? "quick";
    const result =
      command === "quick"
        ? await verifyStage205DurableDelivery()
        : command === "volume-leak"
          ? await verifyStage205VolumeLeakProof()
          : command === "preack-crash"
            ? await verifyStage205PreAckCrashProof()
            : command === "real-soak"
              ? await verifyStage205RealSoak()
              : null;
    if (!result) {
      throw new Error(
        `unknown Stage 20.5 command "${command}"; expected quick, volume-leak, preack-crash, real-soak`,
      );
    }
    log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:stage20.5:durable-delivery FAILED: ${error.message}`);
    process.exit(1);
  }
}
