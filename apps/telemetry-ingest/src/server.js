import { createServer } from "node:http";

import {
  AdmissionError,
  DEFAULT_LIMITS,
  RABBITMQ,
  buildAmqpUrl,
  buildDurableMessage,
  connectRabbit,
  mapSanitizationError,
  optionalIntEnv,
  readSecret,
  requiredEnv,
  validateAdmissionRequest,
} from "@chicek/telemetry-delivery-core";
import { createRuntimeControlGuard, validateControlUrl } from "./runtime-control.js";

const PORT = optionalIntEnv("PORT", 4313);
const MAX_RUM_BYTES = optionalIntEnv("RUM_MAX_BYTES", DEFAULT_LIMITS.rumMaxBytes);
const MAX_LOG_BYTES = optionalIntEnv("LOGS_MAX_BYTES", DEFAULT_LIMITS.logsMaxBytes);
const CONFIRM_TIMEOUT_MS = optionalIntEnv("PUBLISH_CONFIRM_TIMEOUT_MS", 5000);
const SHUTDOWN_TIMEOUT_MS = 5000;
// OBSERVABILITY_CONTROL_URL is a required security/privacy control (kill switch
// enforcement). Missing or malformed values must fail startup, not silently
// disable the check — see docs/security-model.md.
const CONTROL_URL = validateControlUrl(requiredEnv("OBSERVABILITY_CONTROL_URL"));
const CONTROL_TIMEOUT_MS = optionalIntEnv("OBSERVABILITY_CONTROL_TIMEOUT_MS", 1000);
const assertRuntimeControlOpen = createRuntimeControlGuard({
  url: CONTROL_URL,
  timeoutMs: CONTROL_TIMEOUT_MS,
});

let connection;
let channel;
let blocked = false;
let ready = false;
let shuttingDown = false;

async function initializeRabbit() {
  const username = readSecret(requiredEnv("RABBITMQ_INGEST_USERNAME_FILE"));
  const password = readSecret(requiredEnv("RABBITMQ_INGEST_PASSWORD_FILE"));
  connection = await connectRabbit({
    url: buildAmqpUrl({
      username,
      password,
      host: requiredEnv("RABBITMQ_HOST"),
      vhost: process.env.RABBITMQ_VHOST ?? "/",
    }),
    clientProperties: { connection_name: "chicek-telemetry-ingest" },
  });
  connection.on("blocked", () => {
    blocked = true;
  });
  connection.on("unblocked", () => {
    blocked = false;
  });
  connection.on("close", () => {
    ready = false;
    if (!shuttingDown) {
      console.error(JSON.stringify({ event: "telemetry_ingest_rabbitmq_closed" }));
      process.exit(1);
    }
  });
  connection.on("error", (error) => {
    ready = false;
    if (!shuttingDown) {
      console.error(
        JSON.stringify({ event: "telemetry_ingest_rabbitmq_error", error: error.message }),
      );
      process.exit(1);
    }
  });
  channel = await connection.createConfirmChannel();
  channel.on("close", () => {
    ready = false;
    if (!shuttingDown) {
      console.error(JSON.stringify({ event: "telemetry_ingest_channel_closed" }));
      process.exit(1);
    }
  });
  channel.on("error", (error) => {
    ready = false;
    if (!shuttingDown) {
      console.error(
        JSON.stringify({ event: "telemetry_ingest_channel_error", error: error.message }),
      );
      process.exit(1);
    }
  });
  ready = true;
}

const server = createServer(async (req, res) => {
  try {
    if (["/health", "/healthz", "/readyz"].includes(req.url) && req.method === "GET") {
      sendJson(res, ready ? 200 : 503, { status: ready ? "ok" : "unavailable" });
      return;
    }

    const rawBody = await readBody(req, maxBytesForUrl(req.url));
    const admission = validateAdmissionRequest({
      method: req.method,
      url: req.url,
      headers: req.headers,
      rawBody,
      maxBytes: maxBytesForUrl(req.url),
    });
    const trustedScope = trustedScopeFromHeaders(req.headers);
    if (!ready || blocked || !channel) throw new AdmissionError(503, "rabbitmq_unavailable");
    await assertRuntimeControlOpen(trustedScope);

    let message;
    try {
      message = buildDurableMessage({
        signal: admission.signal,
        rawBody,
        trustedScope,
      });
    } catch (error) {
      throw mapSanitizationError(error);
    }

    await publishConfirmed(message);
    sendJson(res, 202, {
      accepted: true,
      schemaVersion: message.schemaVersion,
      eventId: message.eventId,
      batchId: message.batchId,
      signal: message.signal,
    });
  } catch (error) {
    const statusCode = error instanceof AdmissionError ? error.statusCode : 503;
    const code = error instanceof AdmissionError ? error.code : "admission_unavailable";
    sendJson(res, statusCode, { accepted: false, error: code });
  }
});

await initializeRabbit();

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "telemetry_ingest_started", port: PORT }));
});

function publishConfirmed(message) {
  const body = Buffer.from(JSON.stringify(message));
  const routingKey = RABBITMQ.routingKeys[message.signal];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AdmissionError(503, "publisher_confirm_timeout")),
      CONFIRM_TIMEOUT_MS,
    );
    try {
      const writable = channel.publish(
        RABBITMQ.exchange,
        routingKey,
        body,
        {
          contentType: "application/json",
          deliveryMode: 2,
          persistent: true,
          messageId: message.eventId,
          headers: {
            batchId: message.batchId,
            signal: message.signal,
            schemaVersion: message.schemaVersion,
          },
          timestamp: Date.now(),
        },
        (error) => {
          clearTimeout(timer);
          if (error) reject(new AdmissionError(503, "publisher_confirm_nack"));
          else resolve({ writable });
        },
      );
    } catch {
      clearTimeout(timer);
      reject(new AdmissionError(503, "publisher_confirm_failed"));
    }
  });
}

function maxBytesForUrl(url) {
  if (String(url).startsWith("/rum/v1/default/logs")) return MAX_LOG_BYTES;
  return MAX_RUM_BYTES;
}

function trustedScopeFromHeaders(headers) {
  const service = boundedScope(headers["x-observability-service"]);
  const environment = boundedScope(headers["x-observability-environment"]);
  const version = optionalScope(headers["x-observability-version"]);
  if (!service || !environment) throw new AdmissionError(403, "trusted_scope_required");
  return { service, environment, version };
}

function boundedScope(value) {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string") return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(text)) return null;
  return text;
}

function optionalScope(value) {
  if (value === undefined) return null;
  return boundedScope(value);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AdmissionError(413, "payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function shutdown(signal) {
  shuttingDown = true;
  console.log(JSON.stringify({ event: "telemetry_ingest_shutdown", signal }));
  const timer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  server.close(async () => {
    await channel?.close().catch(() => {});
    await connection?.close().catch(() => {});
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
