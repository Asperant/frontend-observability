import { createServer as createHttpServer } from "node:http";

export const MAX_DELAY_MS = 5000;
const TIMEOUT_HOLD_MS = 3000;
const LARGE_RESPONSE_ITEM_COUNT = 5000;
const MAX_ALERT_SINK_EVENTS = 100;
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

function readRequestBody(req, { maxBytes = 32_768 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(rawBody) {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { parseError: true };
  }
}

function createAlertSinkState() {
  return {
    enabled: true,
    events: [],
  };
}

function sanitizeAlertSinkBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const allowed = [
    // Real, live-verified OpenObserve scheduled-alert notification fields
    // (docs/openobserve-v0.91-alert-capabilities.md capability #16):
    // alert_name/alert_agg_value/alert_period/alert_trigger_time_str/
    // stream_name/org_name/alert_description are the only tokens this
    // pinned build actually substitutes.
    "alert",
    "measuredValue",
    "evaluationWindowMinutes",
    "firingTime",
    "stream",
    "org",
    "description",
    // scripts/lab/alerts-test-notification.mjs's own synthetic probe fields
    // (a manually-constructed firing/resolved pair sent straight to this
    // sink to verify it can handle either shape — not fields OpenObserve's
    // real scheduled-alert engine currently populates).
    "severity",
    "status",
    "service",
    "environment",
    "version",
    "threshold",
    "sampleSize",
    "evaluationWindow",
    "dashboardRef",
    "runbookRef",
    "dedupKey",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => Object.hasOwn(body, key))
      .map((key) => [key, typeof body[key] === "string" ? body[key].slice(0, 512) : body[key]]),
  );
}

async function handleAlertSink(req, res, state, segments) {
  if (segments.length === 2 && segments[1] === "events" && req.method === "GET") {
    sendJson(res, 200, {
      enabled: state.enabled,
      count: state.events.length,
      events: state.events,
    });
    return;
  }

  if (segments.length === 2 && segments[1] === "reset" && req.method === "POST") {
    state.events = [];
    state.enabled = true;
    sendJson(res, 200, { status: "reset" });
    return;
  }

  if (segments.length === 2 && segments[1] === "disable" && req.method === "POST") {
    state.enabled = false;
    sendJson(res, 200, { status: "disabled" });
    return;
  }

  if (segments.length === 2 && segments[1] === "enable" && req.method === "POST") {
    state.enabled = true;
    sendJson(res, 200, { status: "enabled" });
    return;
  }

  if (segments.length === 1 && req.method === "POST") {
    if (!state.enabled) {
      sendJson(res, 503, { error: "alert_sink_disabled" });
      return;
    }
    const rawBody = await readRequestBody(req);
    const event = {
      receivedAt: new Date().toISOString(),
      body: sanitizeAlertSinkBody(parseJsonBody(rawBody)),
    };
    state.events.push(event);
    state.events = state.events.slice(-MAX_ALERT_SINK_EVENTS);
    sendJson(res, 202, { accepted: true, count: state.events.length });
    return;
  }

  methodNotAllowed(res);
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
 * Deterministic, dependency-free HTTP test service for the browser app fixture and
 * end-to-end tests. It has no business logic: every route returns a fixed,
 * predictable shape. Request headers and bodies are never read for logging.
 */
export function createMockApiServer() {
  const alertSinkState = createAlertSinkState();

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[0] === "alert-sink") {
      try {
        await handleAlertSink(req, res, alertSinkState, segments);
      } catch {
        sendJson(res, 400, { error: "invalid_alert_sink_request" });
      }
      return;
    }

    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

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
