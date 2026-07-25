import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

import { leafCertPath } from "./common.mjs";
import { requestHttps, requestHttp } from "./verify-http.mjs";

function expectStatus(findings, label, actual, expected) {
  if (actual !== expected) {
    findings.push(`${label}: expected HTTP ${expected}, got ${actual}.`);
  }
}

export async function checkTlsAndProxy() {
  const findings = [];

  const cert = new X509Certificate(readFileSync(leafCertPath));
  if (cert.checkHost("localhost") === undefined)
    findings.push("Leaf certificate SAN is missing DNS:localhost.");
  if (cert.checkIP("127.0.0.1") === undefined)
    findings.push("Leaf certificate SAN is missing IP:127.0.0.1.");
  if (new Date(cert.validTo).getTime() < Date.now()) findings.push("Leaf certificate has expired.");

  const healthz = await requestHttps("/healthz");
  expectStatus(findings, "GET /healthz", healthz.statusCode, 200);

  const root = await requestHttps("/");
  expectStatus(findings, "GET /", root.statusCode, 200);
  const securityHeaders = [
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "strict-transport-security",
  ];
  for (const header of securityHeaders) {
    if (!root.headers[header]) findings.push(`GET /: missing security header "${header}".`);
  }

  const config = await requestHttps("/observability/config.json");
  expectStatus(findings, "GET /observability/config.json", config.statusCode, 200);
  if (!config.headers["content-type"]?.includes("application/json")) {
    findings.push("GET /observability/config.json: Content-Type is not application/json.");
  }
  if (config.headers["cache-control"] !== "no-store") {
    findings.push(
      `GET /observability/config.json: Cache-Control is "${config.headers["cache-control"]}", expected "no-store".`,
    );
  }
  if (config.headers["x-content-type-options"] !== "nosniff") {
    findings.push("GET /observability/config.json: missing X-Content-Type-Options: nosniff.");
  }
  let parsedConfig;
  try {
    parsedConfig = JSON.parse(config.body);
  } catch {
    findings.push("GET /observability/config.json: response body is not valid JSON.");
  }
  if (parsedConfig && parsedConfig.enabled !== true) {
    findings.push(
      "GET /observability/config.json: expected enabled=true in the OpenObserve integration lab.",
    );
  }
  if (parsedConfig) {
    if (parsedConfig.sessionReplay?.enabled !== false) {
      findings.push("GET /observability/config.json: sessionReplay must stay disabled.");
    }
    if (parsedConfig.rum?.site !== "localhost:8443") {
      findings.push("GET /observability/config.json: unexpected rum.site.");
    }
    if (
      parsedConfig.rum?.apiVersion !== "v1" ||
      parsedConfig.rum?.organizationIdentifier !== "default"
    ) {
      findings.push(
        "GET /observability/config.json: rum.apiVersion/organizationIdentifier do not match the ingestion allowlist.",
      );
    }
    if (
      typeof parsedConfig.rum?.clientToken !== "string" ||
      parsedConfig.rum.clientToken.length < 16
    ) {
      findings.push("GET /observability/config.json: rum.clientToken missing or too short.");
    }
  }

  const mockStatus200 = await requestHttps("/mock/status/200");
  expectStatus(findings, "GET /mock/status/200", mockStatus200.statusCode, 200);
  const mockStatus404 = await requestHttps("/mock/status/404");
  expectStatus(findings, "GET /mock/status/404", mockStatus404.statusCode, 404);
  const mockStatus500 = await requestHttps("/mock/status/500");
  expectStatus(findings, "GET /mock/status/500", mockStatus500.statusCode, 500);
  const mockDelay = await requestHttps("/mock/delay/50");
  expectStatus(findings, "GET /mock/delay/50", mockDelay.statusCode, 200);

  const apiDeny = await requestHttps("/api/default/foo");
  expectStatus(findings, "GET /api/default/foo (deny)", apiDeny.statusCode, 403);
  const observabilityDeny = await requestHttps("/observability/unknown-path");
  expectStatus(
    findings,
    "GET /observability/unknown-path (deny)",
    observabilityDeny.statusCode,
    404,
  );
  const webDeny = await requestHttps("/web/");
  expectStatus(findings, "GET /web/ (deny)", webDeny.statusCode, 404);

  const postDenied = await requestHttps("/mock/status/200", { method: "POST" });
  expectStatus(findings, "POST /mock/status/200 (method not allowed)", postDenied.statusCode, 405);

  // Exact RUM/browser-logs ingestion allowlist. These probes exercise
  // genuine telemetry admission through the queryless browser-facing proxy;
  // Durable admission returns 202 only after RabbitMQ publisher confirm.
  const ingestionHeaders = {
    Host: "localhost:8443",
    Origin: "https://localhost:8443",
    "Content-Type": "text/plain;charset=UTF-8",
  };
  const rumOk = await requestHttps("/rum/v1/default/rum", {
    method: "POST",
    headers: ingestionHeaders,
    body: JSON.stringify({
      date: Date.now(),
      type: "view",
      service: "chicek-browser-app",
      env: "lab",
      version: "2026.07.1",
      session_id: "tls-proxy-smoke-session",
      view_id: "tls-proxy-smoke-view",
      view: { id: "tls-proxy-smoke-view", url: "https://localhost:8443/tls-proxy-smoke" },
    }),
  });
  expectStatus(findings, "POST /rum/v1/default/rum (real content-type)", rumOk.statusCode, 202);
  const logsOk = await requestHttps("/rum/v1/default/logs", {
    method: "POST",
    headers: ingestionHeaders,
    body: JSON.stringify({
      date: Date.now(),
      message: "tls proxy smoke log",
      status: "info",
      service: "chicek-browser-app",
      env: "lab",
      version: "2026.07.1",
    }),
  });
  expectStatus(findings, "POST /rum/v1/default/logs (real content-type)", logsOk.statusCode, 202);
  const rumWrongContentType = await requestHttps("/rum/v1/default/rum", {
    method: "POST",
    headers: { ...ingestionHeaders, "Content-Type": "application/json" },
    body: "{}",
  });
  expectStatus(
    findings,
    "POST /rum/v1/default/rum (wrong content-type)",
    rumWrongContentType.statusCode,
    415,
  );
  const rumWrongMethod = await requestHttps("/rum/v1/default/rum", {
    headers: { Host: "localhost:8443", Origin: "https://localhost:8443" },
  });
  expectStatus(
    findings,
    "GET /rum/v1/default/rum (method not allowed)",
    rumWrongMethod.statusCode,
    405,
  );
  const replayDenied = await requestHttps("/rum/v1/default/replay", {
    method: "POST",
    headers: ingestionHeaders,
    body: "{}",
  });
  expectStatus(findings, "POST /rum/v1/default/replay (deny)", replayDenied.statusCode, 404);
  const otherOrgDenied = await requestHttps("/rum/v1/otherorg/rum", {
    method: "POST",
    headers: ingestionHeaders,
    body: "{}",
  });
  expectStatus(findings, "POST /rum/v1/otherorg/rum (deny)", otherOrgDenied.statusCode, 404);

  const openobserveHealthz = await requestHttp("/healthz");
  expectStatus(
    findings,
    "GET http://127.0.0.1:5080/healthz (loopback)",
    openobserveHealthz.statusCode,
    200,
  );

  return { pass: findings.length === 0, findings };
}
