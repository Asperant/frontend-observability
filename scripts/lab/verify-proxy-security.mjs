import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import http2 from "node:http2";
import tls from "node:tls";

import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  caCertPath,
  log,
  logError,
  rumClientTokenSecretPath,
  runDockerCompose,
} from "./common.mjs";
import { waitForHealthy } from "./wait.mjs";

const PROXY_ORIGIN = "https://localhost:8443";
const PROXY_HOST = "localhost:8443";
const RUM_PATH = "/rum/v1/default/rum";
const LOGS_PATH = "/rum/v1/default/logs";
const RUM_LIMIT = 64 * 1024;
const LOGS_LIMIT = 32 * 1024;
const SAFE_CANARY = `stage12-canary-${crypto.randomUUID()}`;

function ingestionHeaders(extra = {}) {
  return {
    Host: PROXY_HOST,
    Origin: PROXY_ORIGIN,
    "Content-Type": "text/plain;charset=UTF-8",
    ...extra,
  };
}

function jsonPayload(size, stream) {
  const base =
    stream === "rum"
      ? {
          date: Date.now(),
          type: "view",
          application_id: "chicek-demo-frontend",
          service: "chicek-demo-frontend",
          env: "lab",
          version: "2026.07.1",
          view: { id: crypto.randomUUID(), url: `${PROXY_ORIGIN}/stage12` },
          session: { id: crypto.randomUUID() },
        }
      : {
          date: Date.now(),
          message: "stage12-log",
          status: "info",
          service: "chicek-demo-frontend",
          env: "lab",
          version: "2026.07.1",
        };
  const withoutPad = JSON.stringify({ ...base, pad: "" });
  const padLength = Math.max(0, size - Buffer.byteLength(withoutPad));
  return JSON.stringify({ ...base, pad: "x".repeat(padLength) });
}

function requestProxy(path, { method = "POST", headers = ingestionHeaders(), body = "{}" } = {}) {
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

function expectStatus(findings, label, actual, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual)) {
    findings.push(`${label}: expected ${allowed.join("/")}, got ${actual}.`);
  }
}

async function measureBrowserSdkTraffic(findings) {
  const measurements = [];
  for (const [browserName, engine] of [
    ["chromium", chromium],
    ["firefox", firefox],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const requests = [];
      const responses = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname !== RUM_PATH && url.pathname !== LOGS_PATH) return;
        const body = request.postDataBuffer();
        requests.push({
          path: url.pathname,
          search: url.search,
          size: body ? body.length : 0,
          contentType: request.headers()["content-type"],
        });
      });
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname === RUM_PATH || url.pathname === LOGS_PATH) {
          responses.push({ path: url.pathname, status: response.status() });
        }
      });

      await page.goto(PROXY_ORIGIN);
      await page.getByTestId("scenario-initialize-runtime-config").click();
      await page.getByTestId("scenario-consent-grant").click();
      await page.getByTestId("scenario-record-action").click();
      await page.getByTestId("scenario-record-error").click();
      await page.getByTestId("scenario-success-request").click();
      await page.waitForTimeout(300);
      await Promise.all([
        page.waitForRequest((request) => {
          const path = new URL(request.url()).pathname;
          return path === RUM_PATH || path === LOGS_PATH;
        }),
        page.reload(),
      ]);
      await page.waitForTimeout(500);

      if (requests.length === 0) {
        findings.push(`${browserName}: no SDK ingestion requests observed.`);
      }
      for (const request of requests) {
        if (request.search !== "") findings.push(`${browserName}: SDK request had a query string.`);
        if (!/^text\/plain(?:\s*;\s*charset=utf-8)?$/i.test(request.contentType ?? "")) {
          findings.push(`${browserName}: unexpected SDK content-type.`);
        }
        measurements.push({ browserName, ...request });
      }
      for (const response of responses) {
        if (response.status >= 400) {
          findings.push(`${browserName}: SDK ingestion returned ${response.status}.`);
        }
      }
    } finally {
      await browser.close();
    }
  }
  return measurements;
}

async function checkPositiveAndPolicy(findings) {
  for (const [path, stream] of [
    [RUM_PATH, "rum"],
    [LOGS_PATH, "logs"],
  ]) {
    for (const contentType of [
      "text/plain",
      "text/plain; charset=utf-8",
      "TEXT/PLAIN ; CHARSET = UTF-8",
    ]) {
      const response = await requestProxy(path, {
        headers: ingestionHeaders({ "Content-Type": contentType, "Sec-Fetch-Site": "same-origin" }),
        body: jsonPayload(1024, stream),
      });
      expectStatus(findings, `${path} ${contentType}`, response.statusCode, 202);
    }

    expectStatus(
      findings,
      `${path} GET`,
      (await requestProxy(path, { method: "GET", headers: ingestionHeaders(), body: undefined }))
        .statusCode,
      405,
    );
    expectStatus(
      findings,
      `${path} query`,
      (await requestProxy(`${path}?${encodeURIComponent(SAFE_CANARY)}=1`)).statusCode,
      404,
    );
    expectStatus(
      findings,
      `${path} missing content-type`,
      (await requestProxy(path, { headers: { Host: PROXY_HOST, Origin: PROXY_ORIGIN } }))
        .statusCode,
      415,
    );
    expectStatus(
      findings,
      `${path} extra content-type parameter`,
      (
        await requestProxy(path, {
          headers: ingestionHeaders({ "Content-Type": "text/plain; charset=utf-8; boundary=x" }),
        })
      ).statusCode,
      415,
    );
    expectStatus(
      findings,
      `${path} content-encoding`,
      (await requestProxy(path, { headers: ingestionHeaders({ "Content-Encoding": "gzip" }) }))
        .statusCode,
      415,
    );
    expectStatus(
      findings,
      `${path} wrong host`,
      (await requestProxy(path, { headers: ingestionHeaders({ Host: "evil.invalid" }) }))
        .statusCode,
      403,
    );
    expectStatus(
      findings,
      `${path} missing origin`,
      (await requestProxy(path, { headers: { Host: PROXY_HOST, "Content-Type": "text/plain" } }))
        .statusCode,
      403,
    );
    expectStatus(
      findings,
      `${path} cross-site fetch metadata`,
      (await requestProxy(path, { headers: ingestionHeaders({ "Sec-Fetch-Site": "cross-site" }) }))
        .statusCode,
      403,
    );
  }
}

async function checkBodyLimits(findings) {
  const rumUnder = await requestProxy(RUM_PATH, { body: jsonPayload(RUM_LIMIT - 1024, "rum") });
  expectStatus(findings, "RUM under body limit", rumUnder.statusCode, 202);
  const rumOver = await requestProxy(RUM_PATH, { body: jsonPayload(RUM_LIMIT + 1, "rum") });
  expectStatus(findings, "RUM over body limit", rumOver.statusCode, 413);

  const logsUnder = await requestProxy(LOGS_PATH, { body: jsonPayload(LOGS_LIMIT - 1024, "logs") });
  expectStatus(findings, "logs under body limit", logsUnder.statusCode, 202);
  const logsOver = await requestProxy(LOGS_PATH, { body: jsonPayload(LOGS_LIMIT + 1, "logs") });
  expectStatus(findings, "logs over body limit", logsOver.statusCode, 413);

  const chunked = await rawTlsRequest(
    [
      `POST ${LOGS_PATH} HTTP/1.1`,
      `Host: ${PROXY_HOST}`,
      `Origin: ${PROXY_ORIGIN}`,
      "Content-Type: text/plain",
      "Transfer-Encoding: chunked",
      "",
      "",
    ].join("\r\n"),
    {
      chunks: [`${(LOGS_LIMIT + 1).toString(16)}\r\n`, "x".repeat(LOGS_LIMIT + 1), "\r\n0\r\n\r\n"],
    },
  );
  expectStatus(findings, "chunked oversized", chunked.statusCode, 413);

  const slow = await rawTlsRequest(
    [
      `POST ${LOGS_PATH} HTTP/1.1`,
      `Host: ${PROXY_HOST}`,
      `Origin: ${PROXY_ORIGIN}`,
      "Content-Type: text/plain",
      "Content-Length: 10",
      "",
      "x",
    ].join("\r\n"),
    { endImmediately: false },
  );
  expectStatus(findings, "slow partial body timeout", slow.statusCode, [0, 400, 408]);
  if (slow.elapsedMs > 12_000) {
    findings.push(`slow partial body timeout exceeded budget: ${slow.elapsedMs}ms.`);
  }
}

async function checkRateAndConnectionLimits(findings) {
  const burst = await Promise.all(
    Array.from({ length: 80 }, () => requestProxy(LOGS_PATH, { body: jsonPayload(512, "logs") })),
  );
  if (!burst.some((response) => response.statusCode === 429)) {
    findings.push("rate limit: no request returned 429 during burst probe.");
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const holders = [];
  for (let i = 0; i < 24; i += 1) {
    holders.push(await openHoldingTlsRequest(LOGS_PATH));
  }
  try {
    const limited = await requestProxy(LOGS_PATH, { body: jsonPayload(512, "logs") });
    expectStatus(findings, "connection limit", limited.statusCode, 429);
  } finally {
    for (const socket of holders) socket.destroy();
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

function openHoldingTlsRequest(path) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: "127.0.0.1",
        port: 8443,
        servername: "localhost",
        ca: readFileSync(caCertPath),
      },
      () => {
        socket.write(
          [
            `POST ${path} HTTP/1.1`,
            `Host: ${PROXY_HOST}`,
            `Origin: ${PROXY_ORIGIN}`,
            "Content-Type: text/plain",
            "Content-Length: 1024",
            "",
            "x",
          ].join("\r\n"),
        );
        resolve(socket);
      },
    );
    socket.on("error", reject);
  });
}

function rawTlsRequest(head, { chunks = [], endImmediately = true, timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let data = "";
    const socket = tls.connect(
      {
        host: "127.0.0.1",
        port: 8443,
        servername: "localhost",
        ca: readFileSync(caCertPath),
      },
      () => {
        socket.write(head);
        for (const chunk of chunks) socket.write(chunk);
        if (endImmediately) socket.end();
      },
    );
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(parseRawStatus(data, started));
    }, timeoutMs);
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (endImmediately && data.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(parseRawStatus(data, started));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(parseRawStatus(data, started));
    });
  });
}

function parseRawStatus(data, started = Date.now()) {
  const match = data.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  return { statusCode: match ? Number(match[1]) : 0, elapsedMs: Date.now() - started };
}

async function checkProtocolProbes(findings) {
  const probes = [
    {
      label: "conflicting content-length",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.1`,
        `Host: ${PROXY_HOST}`,
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        "Content-Length: 2",
        "Content-Length: 4",
        "",
        "{}",
      ].join("\r\n"),
      expected: [400, 413],
    },
    {
      label: "content-length with transfer-encoding",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.1`,
        `Host: ${PROXY_HOST}`,
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        "Content-Length: 2",
        "Transfer-Encoding: chunked",
        "",
        "0",
        "",
        "",
      ].join("\r\n"),
      expected: [400, 413],
    },
    {
      label: "broken chunk framing",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.1`,
        `Host: ${PROXY_HOST}`,
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        "Transfer-Encoding: chunked",
        "",
        "zz",
        "",
        "",
      ].join("\r\n"),
      expected: [400, 413],
    },
    {
      label: "duplicate content-type",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.1`,
        `Host: ${PROXY_HOST}`,
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        "Content-Type: application/json",
        "Content-Length: 2",
        "",
        "{}",
      ].join("\r\n"),
      expected: [400, 415],
    },
    {
      label: "duplicate host",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.1`,
        `Host: ${PROXY_HOST}`,
        "Host: evil.invalid",
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        "Content-Length: 2",
        "",
        "{}",
      ].join("\r\n"),
      expected: [400, 403],
    },
    {
      label: "missing host",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.1`,
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        "Content-Length: 2",
        "",
        "{}",
      ].join("\r\n"),
      expected: [400, 403],
    },
    {
      label: "long control header",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.1`,
        `Host: ${PROXY_HOST}`,
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        `X-Long: ${"a".repeat(9000)}\x01`,
        "Content-Length: 2",
        "",
        "{}",
      ].join("\r\n"),
      expected: [400, 414],
    },
    {
      label: "http/1.0",
      raw: [
        `POST ${LOGS_PATH} HTTP/1.0`,
        `Origin: ${PROXY_ORIGIN}`,
        "Content-Type: text/plain",
        "Content-Length: 2",
        "",
        "{}",
      ].join("\r\n"),
      expected: [400, 403],
    },
  ];
  for (const probe of probes) {
    const response = await rawTlsRequest(probe.raw);
    expectStatus(findings, probe.label, response.statusCode, probe.expected);
  }

  const h2 = await http2Post(LOGS_PATH, jsonPayload(512, "logs"));
  expectStatus(findings, "http/2 normal SDK-shaped flow", h2.statusCode, 202);
}

function http2Post(path, body) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(PROXY_ORIGIN, {
      ca: readFileSync(caCertPath),
      rejectUnauthorized: true,
    });
    client.on("error", reject);
    const req = client.request({
      ":method": "POST",
      ":path": path,
      ":authority": PROXY_HOST,
      origin: PROXY_ORIGIN,
      "content-type": "text/plain;charset=UTF-8",
      "content-length": Buffer.byteLength(body),
    });
    req.on("response", (headers) => {
      resolve({ statusCode: Number(headers[":status"] ?? 0), headers });
      client.close();
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function checkPathIsolation(findings) {
  const paths = [
    "/rum/v2/default/rum",
    "/rum/v1/other/rum",
    "/rum/v1/default/rum/",
    "/rum/v1/default//rum",
    "/rum/v1/default/../default/rum",
    "/rum/v1/default%2Frum",
    "/rum/v1/default%252Frum",
    "/RUM/v1/default/rum",
    "/rum/v1/default/rum;v=1",
    "/rum/v1/default/%00rum",
    `${RUM_PATH}?x=1`,
    `${RUM_PATH}/${"a".repeat(9000)}`,
    "/rum/v1/default/replay",
    "/replay",
    "/api",
    "/api/default/_search",
    "/_search",
    "/search",
    "/streams",
    "/users",
    "/organizations",
    "/dashboards",
    "/alerts",
    "/functions",
    "/pipelines",
    "/rumtoken",
    "/source-map",
  ];

  runDockerCompose(["stop", "openobserve"]);
  try {
    for (const path of paths) {
      const response = await requestProxy(path, { body: "{}" });
      if ([200, 502, 503, 504].includes(response.statusCode)) {
        findings.push(`${path}: reached or depended on upstream while OpenObserve was stopped.`);
      }
    }
  } finally {
    runDockerCompose(["start", "openobserve"]);
    const health = await waitForHealthy({ services: ["openobserve"], timeoutMs: 120_000 });
    if (!health.healthy) findings.push("openobserve did not recover after path isolation probe.");
  }
}

async function checkOutageIsolation(findings) {
  runDockerCompose(["stop", "openobserve"]);
  try {
    const ingest = await requestProxy(LOGS_PATH, { body: jsonPayload(512, "logs") });
    expectStatus(findings, "OpenObserve stopped durable admission", ingest.statusCode, 202);
    const root = await requestProxy("/", {
      method: "GET",
      headers: { Host: PROXY_HOST },
      body: undefined,
    });
    expectStatus(findings, "frontend while OpenObserve stopped", root.statusCode, 200);
  } finally {
    runDockerCompose(["start", "openobserve"]);
    const health = await waitForHealthy({ services: ["openobserve"], timeoutMs: 120_000 });
    if (!health.healthy) findings.push("openobserve did not recover after outage probe.");
  }
}

async function checkBrowserSuppliedTokenIsolation(findings) {
  const rejected = await requestProxy(`${LOGS_PATH}?o2-api-key=wrong`, {
    body: jsonPayload(512, "logs"),
  });
  expectStatus(findings, "browser-supplied token query", rejected.statusCode, 404);
  const root = await requestProxy("/", {
    method: "GET",
    headers: { Host: PROXY_HOST },
    body: undefined,
  });
  expectStatus(findings, "frontend after rejected browser token", root.statusCode, 200);
}

async function checkSlowUpstreamIsolation(findings) {
  runDockerCompose(["pause", "openobserve"]);
  try {
    const started = Date.now();
    const ingest = await requestProxy(LOGS_PATH, { body: jsonPayload(512, "logs") }).catch(() => ({
      statusCode: 0,
    }));
    const elapsed = Date.now() - started;
    expectStatus(findings, "OpenObserve paused durable admission", ingest.statusCode, 202);
    if (elapsed > 13_000)
      findings.push(`OpenObserve paused timeout exceeded budget: ${elapsed}ms.`);
    const root = await requestProxy("/", {
      method: "GET",
      headers: { Host: PROXY_HOST },
      body: undefined,
    });
    expectStatus(findings, "frontend while OpenObserve paused", root.statusCode, 200);
  } finally {
    runDockerCompose(["unpause", "openobserve"], { allowFailure: true });
    const health = await waitForHealthy({ services: ["openobserve"], timeoutMs: 120_000 });
    if (!health.healthy) findings.push("openobserve did not recover after slow-upstream probe.");
  }
}

function checkRenderedNginx(findings) {
  const result = runDockerCompose(
    [
      "exec",
      "-T",
      "reverse-proxy",
      "sh",
      "-c",
      "nginx -t >/dev/null 2>&1 && nginx -T >/dev/null 2>&1",
    ],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) findings.push("nginx -t/-T failed inside reverse-proxy.");
}

function checkTmpfsBuffering(findings) {
  const result = runDockerCompose(
    ["exec", "-T", "reverse-proxy", "sh", "-c", "df -T /tmp /var/cache/nginx | tail -n +2"],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0 || !result.stdout.includes("tmpfs")) {
    findings.push("reverse-proxy request buffering paths are not backed by tmpfs.");
  }
}

function checkPrivacyLogs(findings) {
  const token = readFileSync(rumClientTokenSecretPath, "utf8").trim();
  const result = runDockerCompose(
    [
      "exec",
      "-T",
      "reverse-proxy",
      "sh",
      "-c",
      "cat /tmp/ingestion-access.log 2>/dev/null || true",
    ],
    { capture: true, allowFailure: true },
  );
  const text = result.stdout ?? "";
  for (const forbidden of [
    token,
    SAFE_CANARY,
    "Authorization",
    "Cookie",
    "Referer",
    "Mozilla",
    "127.0.0.1",
    "::1",
  ]) {
    if (forbidden && text.includes(forbidden)) {
      findings.push("privacy-safe ingestion log check failed.");
      break;
    }
  }
  if (!text.includes('"endpoint":"rum"') || !text.includes('"endpoint":"logs"')) {
    findings.push("ingestion metadata log did not include both endpoint classes.");
  }
}

function summarizeMeasurements(measurements) {
  const summary = { rum: {}, logs: {} };
  for (const item of measurements) {
    const key = item.path.endsWith("/rum") ? "rum" : "logs";
    summary[key][item.browserName] = Math.max(summary[key][item.browserName] ?? 0, item.size);
  }
  return summary;
}

export async function verifyProxySecurity() {
  const findings = [];

  log("stage12: rendered nginx config...");
  checkRenderedNginx(findings);
  checkTmpfsBuffering(findings);

  log("stage12: positive SDK traffic and request-size measurement...");
  const measurements = await measureBrowserSdkTraffic(findings);

  log("stage12: method/content-type/encoding/origin/host policy...");
  await checkPositiveAndPolicy(findings);

  log("stage12: body, chunking, timeout, rate, and connection limits...");
  await checkBodyLimits(findings);
  await checkRateAndConnectionLimits(findings);

  log("stage12: protocol probes...");
  await checkProtocolProbes(findings);

  log("stage12: path and management isolation...");
  await checkPathIsolation(findings);

  log("stage12: OpenObserve failure isolation...");
  await checkOutageIsolation(findings);
  await checkBrowserSuppliedTokenIsolation(findings);
  await checkSlowUpstreamIsolation(findings);

  log("stage12: privacy-safe ingestion logs...");
  await requestProxy(LOGS_PATH, {
    headers: ingestionHeaders({
      Authorization: `Bearer ${SAFE_CANARY}`,
      Cookie: `sid=${SAFE_CANARY}`,
      Referer: `${PROXY_ORIGIN}/?token=${SAFE_CANARY}`,
    }),
    body: JSON.stringify({ message: SAFE_CANARY, status: "info", date: Date.now() }),
  });
  checkPrivacyLogs(findings);

  return {
    pass: findings.length === 0,
    findings,
    measurements: summarizeMeasurements(measurements),
    limits: { rumBytes: RUM_LIMIT, logsBytes: LOGS_LIMIT },
  };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:stage12:proxy-security");
    const result = await verifyProxySecurity();
    if (result.pass) {
      log("\nStage 12 proxy-security verification PASSED.");
      log(`Measured SDK request bytes: ${JSON.stringify(result.measurements)}`);
      log(`Configured body limits: ${JSON.stringify(result.limits)}`);
    } else {
      logError("\nStage 12 proxy-security verification FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:stage12:proxy-security FAILED: ${error.message}`);
    process.exit(1);
  }
}
