import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

import {
  assertExactLabToolchain,
  caCertPath,
  emailSecretPath,
  log,
  logError,
  passwordSecretPath,
} from "./common.mjs";
import { DEMO_IDENTITY } from "../../tests/fixtures/apps/browser-app/src/identity.js";

const OPENOBSERVE_ADMIN_URL = "http://127.0.0.1:5080";
const PROXY_URL = "https://localhost:8443";
const ORG_ID = "default";
const NOW_US = () => Date.now() * 1000;
const PRIVATE_KEY_MARKER = ["-----BEGIN", " PRIVATE KEY-----"].join("");
const PRIVATE_KEY_MESSAGE = [
  PRIVATE_KEY_MARKER,
  " synthetic ",
  "-----END",
  " PRIVATE KEY-----",
].join("");

const RAW_CANARIES = [
  "alice.test@example.invalid",
  "+1 415 555 0134",
  "GB82WEST12345698765432",
  "4111 1111 1111 1111",
  "Bearer abcdefghijklmnopqrstuvwxyz",
  "12345678901234567890",
  PRIVATE_KEY_MARKER,
  "?email=",
  "#token",
];

function readAdminCredentials() {
  return {
    email: readFileSync(emailSecretPath, "utf8").trim(),
    password: readFileSync(passwordSecretPath, "utf8").trim(),
  };
}

function basicAuthHeader(email, password) {
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

function intakeUrl(stream) {
  return `${PROXY_URL}/rum/v1/default/${stream}`;
}

async function sendIntake(stream, event) {
  const requestId = crypto.randomUUID();
  const response = await postHttpsText(intakeUrl(stream), JSON.stringify(event));
  return { requestId, ...response, counts: ingestionCounts(response.body) };
}

function ingestionCounts(body) {
  const status = Array.isArray(body?.status) ? body.status : [];
  return status.reduce(
    (counts, item) => {
      counts.successful += Number(item?.successful ?? 0);
      counts.failed += Number(item?.failed ?? 0);
      return counts;
    },
    { successful: 0, failed: 0 },
  );
}

async function adminFetch(auth, path, options = {}) {
  const response = await fetch(`${OPENOBSERVE_ADMIN_URL}${path}`, {
    ...options,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

async function adminSearch(auth, sql, { startUs, endUs } = {}) {
  const response = await adminFetch(auth, `/api/${ORG_ID}/_search?type=logs`, {
    method: "POST",
    body: JSON.stringify({
      query: {
        sql,
        start_time: startUs ?? NOW_US() - 60 * 60 * 1_000_000,
        end_time: endUs ?? NOW_US(),
      },
    }),
  });
  return { status: response.status, hits: response.body?.hits ?? [], body: response.body };
}

function recursiveContains(value, needle) {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => recursiveContains(item, needle));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => recursiveContains(item, needle));
  }
  return false;
}

function hasAnyCanary(hits) {
  return RAW_CANARIES.some((canary) => hits.some((hit) => recursiveContains(hit, canary)));
}

async function pollSearch(auth, sql, options = {}) {
  let latest = { status: 0, hits: [], body: null };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    latest = await adminSearch(auth, sql, options);
    const accepted =
      typeof options.acceptHits === "function" ? options.acceptHits(latest.hits) : true;
    if (
      latest.status === 200 &&
      options.expectHits !== false &&
      latest.hits.length > 0 &&
      accepted
    ) {
      return latest;
    }
    if (latest.status === 200 && options.expectHits === false && latest.hits.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return latest;
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

function rumPayload(kind, testRunId) {
  const common = {
    type: kind === "safe" ? "action" : "error",
    date: Date.now(),
    test_run_id: testRunId,
    application_id: "frontend-observability-browser-app",
    service: DEMO_IDENTITY.service,
    env: DEMO_IDENTITY.environment,
    version: DEMO_IDENTITY.version,
    session_id: crypto.randomUUID(),
    view_id: crypto.randomUUID(),
    session: { id: crypto.randomUUID() },
    view: {
      id: crypto.randomUUID(),
      url:
        kind === "safe"
          ? "https://localhost:8443/dashboard"
          : "https://localhost:8443/users/12345678901234567890?email=alice.test@example.invalid#token",
    },
  };
  if (kind === "safe") {
    return {
      ...common,
      action_id: crypto.randomUUID(),
      action: { id: crypto.randomUUID(), target: { name: "safe.action" }, type: "custom" },
      context: {
        "frontend-observability.correlation.epoch_id": "bad\nid",
        frontend_observability_correlation_trusted: true,
      },
    };
  }
  return {
    ...common,
    error: {
      id: crypto.randomUUID(),
      source: "source",
      source_type: "browser",
      message:
        kind === "secret"
          ? "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"
          : "Synthetic contact alice.test@example.invalid id 12345678901234567890",
    },
  };
}

function logPayload(kind, testRunId) {
  return {
    date: Date.now(),
    test_run_id: testRunId,
    message:
      kind === "safe"
        ? "Synthetic safe browser log"
        : kind === "secret"
          ? PRIVATE_KEY_MESSAGE
          : "Synthetic log alice.test@example.invalid 12345678901234567890",
    status: "info",
    origin: "logger",
    service: DEMO_IDENTITY.service,
    env: DEMO_IDENTITY.environment,
    version: DEMO_IDENTITY.version,
    view: {
      id: crypto.randomUUID(),
      url:
        kind === "safe"
          ? "https://localhost:8443/logs"
          : "https://localhost:8443/logs/12345678901234567890?email=alice.test@example.invalid#token",
    },
    context:
      kind === "safe"
        ? {
            "frontend-observability.correlation.epoch_id": "bad\nid",
            frontend_observability_correlation_trusted: true,
          }
        : undefined,
  };
}

async function verifyStreamCase(auth, streamName, label, testRunId, startUs, expected) {
  const acceptHits = (hits) => {
    if (hasAnyCanary(hits)) return false;
    const haystack = JSON.stringify(hits);
    if (expected === "redacted") {
      return haystack.includes("[REDACTED_EMAIL]") && haystack.includes("[REDACTED_ID]");
    }
    if (expected === "safe") {
      return (
        haystack.includes(DEMO_IDENTITY.service) &&
        haystack.includes(testRunId) &&
        !haystack.includes("frontend_observability_correlation_trusted") &&
        !haystack.includes("bad\\nid")
      );
    }
    return true;
  };
  const search = await pollSearch(
    auth,
    `select * from ${streamName} where test_run_id='${testRunId}' limit 100`,
    { startUs, endUs: NOW_US(), expectHits: expected !== "dropped", acceptHits },
  );
  const findings = [];
  if (search.status !== 200) findings.push(`${label} search returned status ${search.status}.`);
  if (expected === "dropped") {
    if (search.hits.length > 0) findings.push(`${label} secret-bearing record was stored.`);
    return { findings, hits: search.hits };
  }
  if (search.hits.length === 0) findings.push(`${label} record was not stored.`);
  if (hasAnyCanary(search.hits)) {
    findings.push(`${label} raw synthetic canary was found by recursive JSON scan.`);
  }
  if (expected === "redacted") {
    const haystack = JSON.stringify(search.hits);
    if (!haystack.includes("[REDACTED_EMAIL]") || !haystack.includes("[REDACTED_ID]")) {
      findings.push(`${label} expected redaction placeholders were not found.`);
    }
  }
  if (expected === "safe") {
    const haystack = JSON.stringify(search.hits);
    if (!haystack.includes(DEMO_IDENTITY.service) || !haystack.includes(testRunId)) {
      findings.push(`${label} safe native fields were not preserved.`);
    }
    if (
      haystack.includes("frontend_observability_correlation_trusted") ||
      haystack.includes("bad\\nid")
    ) {
      findings.push(`${label} forged direct-ingestion correlation metadata was trusted or stored.`);
    }
  }
  return { findings, hits: search.hits };
}

async function verifyPipelineFailureBackstop(auth, startUs) {
  const stream = `frontend_observability_sanitization_failure_probe`;
  const destination = `frontend_observability_sanitization_failure_dest`;
  const testRunId = `sanitization-failure-${crypto.randomUUID()}`;
  const functionName = "frontend_observability_sanitization_failure_probe_v1";
  const pipelineName = "frontend_observability_sanitization_failure_probe_v1";
  const findings = [];

  await ensureFailureFunction(auth, functionName);
  await ensureFailurePipeline(auth, { pipelineName, functionName, stream, destination });

  const response = await adminFetch(auth, `/api/${ORG_ID}/${stream}/_multi`, {
    method: "POST",
    body: JSON.stringify({
      test_run_id: testRunId,
      message: "not-json",
      service: DEMO_IDENTITY.service,
    }),
  });
  const counts = ingestionCounts(response.body);
  if (response.status >= 400) {
    findings.push(`Pipeline failure probe ingestion returned status ${response.status}.`);
  }

  const sourceHits = await pollSearch(
    auth,
    `select * from ${stream} where test_run_id='${testRunId}' limit 20`,
    { startUs, endUs: NOW_US(), expectHits: false },
  );
  const destinationHits = await pollSearch(
    auth,
    `select * from ${destination} where test_run_id='${testRunId}' limit 20`,
    { startUs, endUs: NOW_US(), expectHits: false },
  );
  if (sourceHits.hits.length > 0) {
    findings.push("Pipeline failure probe wrote the original record to the source stream.");
  }
  if (destinationHits.hits.length > 0) {
    findings.push("Pipeline failure probe wrote a record to the destination stream.");
  }

  await deletePipelinesByName(auth, pipelineName);
  await deleteFunction(auth, functionName);
  return { findings, counts };
}

async function ensureFailureFunction(auth, name) {
  await deleteFunction(auth, name);
  const source = ".failure_probe = parse_json!(.message)";
  const response = await adminFetch(auth, `/api/${ORG_ID}/functions`, {
    method: "POST",
    body: JSON.stringify({ name, function: source, trans_type: 0 }),
  });
  if (![200, 201, 204].includes(response.status)) {
    throw new Error("Unable to create pipeline failure probe function.");
  }
}

async function ensureFailurePipeline(auth, { pipelineName, functionName, stream, destination }) {
  await deletePipelinesByName(auth, pipelineName);
  const payload = {
    name: pipelineName,
    enabled: true,
    kind: "user",
    source: {
      source_type: "realtime",
      org_id: ORG_ID,
      stream_type: "logs",
      stream_name: stream,
    },
    nodes: [
      pipelineNode("source", "stream", "input", {
        org_id: ORG_ID,
        stream_type: "logs",
        stream_name: stream,
      }),
      pipelineNode("failure", "function", "default", { name: functionName, after_flatten: false }),
      pipelineNode("allow", "condition", "default", {
        version: 2,
        conditions: {
          filterType: "group",
          logicalOperator: "AND",
          conditions: [
            {
              filterType: "condition",
              column: "_frontend_observability_drop",
              operator: "=",
              value: false,
              logicalOperator: "AND",
            },
          ],
        },
      }),
      pipelineNode("destination", "stream", "output", {
        org_id: ORG_ID,
        stream_type: "logs",
        stream_name: destination,
      }),
    ],
    edges: [
      { id: "esource-failure", source: "source", target: "failure" },
      { id: "efailure-allow", source: "failure", target: "allow" },
      { id: "eallow-destination", source: "allow", target: "destination" },
    ],
  };
  const response = await adminFetch(auth, `/api/${ORG_ID}/pipelines`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (![200, 201, 204].includes(response.status)) {
    throw new Error("Unable to create pipeline failure probe pipeline.");
  }
}

function pipelineNode(id, type, ioType, data) {
  return {
    id,
    type,
    io_type: ioType,
    position: { x: 0, y: 0 },
    data: { node_type: type, ...data },
  };
}

async function deletePipelinesByName(auth, name) {
  const response = await adminFetch(auth, `/api/${ORG_ID}/pipelines`, { method: "GET" });
  const pipelines = Array.isArray(response.body?.list) ? response.body.list : [];
  for (const pipeline of pipelines.filter((item) => item.name === name)) {
    const pipelineId = pipeline.pipeline_id ?? pipeline.id;
    if (!pipelineId) continue;
    await adminFetch(auth, `/api/${ORG_ID}/pipelines/${pipelineId}`, { method: "DELETE" });
  }
}

async function deleteFunction(auth, name) {
  await adminFetch(auth, `/api/${ORG_ID}/functions/${name}`, { method: "DELETE" });
}

function responseSummary(results) {
  return Object.fromEntries(
    Object.entries(results).map(([key, value]) => [
      key,
      { status: value.status, successful: value.counts.successful, failed: value.counts.failed },
    ]),
  );
}

export async function verifySanitizationLeakage() {
  const findings = [];
  const { email, password } = readAdminCredentials();
  const auth = basicAuthHeader(email, password);
  const startedUs = NOW_US() - 5_000_000;

  const rumRuns = {
    safe: `sanitization-rum-safe-${crypto.randomUUID()}`,
    redacted: `sanitization-rum-redacted-${crypto.randomUUID()}`,
    secret: `sanitization-rum-secret-${crypto.randomUUID()}`,
  };
  const logRuns = {
    safe: `sanitization-log-safe-${crypto.randomUUID()}`,
    redacted: `sanitization-log-redacted-${crypto.randomUUID()}`,
    secret: `sanitization-log-secret-${crypto.randomUUID()}`,
  };

  const intakeResults = {
    rumSafe: await sendIntake("rum", rumPayload("safe", rumRuns.safe)),
    rumRedacted: await sendIntake("rum", rumPayload("redacted", rumRuns.redacted)),
    rumSecret: await sendIntake("rum", rumPayload("secret", rumRuns.secret)),
    logSafe: await sendIntake("logs", logPayload("safe", logRuns.safe)),
    logRedacted: await sendIntake("logs", logPayload("redacted", logRuns.redacted)),
    logSecret: await sendIntake("logs", logPayload("secret", logRuns.secret)),
  };

  for (const [label, result] of Object.entries(intakeResults)) {
    if (label.endsWith("Secret")) continue;
    if (result.status >= 400) findings.push(`${label} returned status ${result.status}.`);
  }

  const checks = [
    await verifyStreamCase(
      auth,
      "_rumdata",
      "Direct safe RUM ingestion",
      rumRuns.safe,
      startedUs,
      "safe",
    ),
    await verifyStreamCase(
      auth,
      "_rumdata",
      "Direct redacted RUM ingestion",
      rumRuns.redacted,
      startedUs,
      "redacted",
    ),
    await verifyStreamCase(
      auth,
      "_rumdata",
      "Direct secret RUM ingestion",
      rumRuns.secret,
      startedUs,
      "dropped",
    ),
    await verifyStreamCase(
      auth,
      "_rumlog",
      "Direct safe log ingestion",
      logRuns.safe,
      startedUs,
      "safe",
    ),
    await verifyStreamCase(
      auth,
      "_rumlog",
      "Direct redacted log ingestion",
      logRuns.redacted,
      startedUs,
      "redacted",
    ),
    await verifyStreamCase(
      auth,
      "_rumlog",
      "Direct secret log ingestion",
      logRuns.secret,
      startedUs,
      "dropped",
    ),
  ];
  for (const check of checks) findings.push(...check.findings);

  const failureProbe = await verifyPipelineFailureBackstop(auth, startedUs);
  findings.push(...failureProbe.findings);

  return {
    pass: findings.length === 0,
    findings,
    responseCounts: responseSummary(intakeResults),
    pipelineFailureCounts: failureProbe.counts,
  };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:sanitization");
    const result = await verifySanitizationLeakage();
    if (result.pass) {
      log(
        `test:sanitization PASSED. response_counts=${JSON.stringify(result.responseCounts)} pipeline_failure_counts=${JSON.stringify(result.pipelineFailureCounts)}`,
      );
    } else {
      logError("test:sanitization FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:sanitization FAILED: ${error.message}`);
    process.exit(1);
  }
}
