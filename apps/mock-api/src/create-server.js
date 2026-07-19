import { createServer as createHttpServer } from "node:http";

export const MAX_DELAY_MS = 5000;
const TIMEOUT_HOLD_MS = 3000;
const LARGE_RESPONSE_ITEM_COUNT = 5000;
const SUPPORTED_STATUS_CODES = new Set([200, 400, 404, 429, 500, 503]);
const FORBIDDEN_CORRELATION_HEADERS = Object.freeze([
  "traceparent",
  "tracestate",
  "baggage",
  "x-request-id",
  "x-correlation-id",
  "x-datadog-trace-id",
  "x-datadog-parent-id",
]);

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

function methodNotAllowed(res) {
  sendJson(res, 405, { error: "method_not_allowed" });
}

function handleStatus(res, code) {
  sendJson(res, code, { status: code });
}

function handleDelay(res, rawMilliseconds) {
  const requested = Number.parseInt(rawMilliseconds, 10);
  const milliseconds = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), MAX_DELAY_MS)
    : 0;
  setTimeout(() => {
    sendJson(res, 200, { delayedMs: milliseconds });
  }, milliseconds);
}

function handleTimeout(req, res) {
  const holdTimer = setTimeout(() => {
    req.socket.destroy();
  }, TIMEOUT_HOLD_MS);
  res.once("close", () => clearTimeout(holdTimer));
}

function handleLargeResponse(res) {
  const items = Array.from({ length: LARGE_RESPONSE_ITEM_COUNT }, (_, index) => ({
    index,
    value: "x".repeat(32),
  }));
  sendJson(res, 200, { items });
}

function handleHeaderPresence(req, res) {
  sendJson(res, 200, {
    forbiddenCorrelationHeaders: Object.fromEntries(
      FORBIDDEN_CORRELATION_HEADERS.map((header) => [header, header in req.headers]),
    ),
  });
}

/**
 * Deterministic, dependency-free mock HTTP API for the demo frontend and
 * end-to-end tests. It has no business logic: every route returns a fixed,
 * predictable shape. Request headers and bodies are never read for logging.
 */
export function createMockApiServer() {
  return createHttpServer((req, res) => {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length === 1 && segments[0] === "health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (segments[0] === "status" && segments.length === 2) {
      const code = Number.parseInt(segments[1], 10);
      if (SUPPORTED_STATUS_CODES.has(code)) {
        handleStatus(res, code);
        return;
      }
    }

    if (segments[0] === "delay" && segments.length === 2) {
      handleDelay(res, segments[1]);
      return;
    }

    if (segments.length === 1 && segments[0] === "timeout") {
      handleTimeout(req, res);
      return;
    }

    if (segments.length === 1 && segments[0] === "large-response") {
      handleLargeResponse(res);
      return;
    }

    if (segments.length === 1 && segments[0] === "headers") {
      handleHeaderPresence(req, res);
      return;
    }

    notFound(res);
  });
}
