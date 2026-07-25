import { createServer } from "node:http";

import { createControlPlaneState } from "./state.js";

const PORT = Number.parseInt(process.env.PORT ?? "4314", 10);
const STATE_DIR = process.env.OBSERVABILITY_CONTROL_STATE_DIR ?? "/var/lib/chicek-control-plane";

const controlPlane = createControlPlaneState(STATE_DIR);

const server = createServer((req, res) => {
  try {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (req.url === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.url === "/readyz") {
      const status = controlPlane.status(new Date(), scopeFromHeaders(req.headers));
      sendJson(res, status.ready ? 200 : 503, status);
      return;
    }
    if (req.url === "/observability/config.json") {
      sendRawJson(res, 200, controlPlane.getActiveConfig(scopeFromHeaders(req.headers)));
      return;
    }
    if (req.url === "/observability/control.json") {
      sendRawJson(res, 200, controlPlane.getActiveControl(scopeFromHeaders(req.headers)));
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  } catch {
    sendJson(res, 503, { error: "control_plane_unready" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "observability_control_plane_started", port: PORT }));
});

function sendRawJson(res, statusCode, body) {
  res.writeHead(statusCode, headers(Buffer.byteLength(body)));
  res.end(body);
}

function sendJson(res, statusCode, body) {
  const text = `${JSON.stringify(body)}\n`;
  sendRawJson(res, statusCode, text);
}

function headers(contentLength) {
  return {
    "content-type": "application/json; charset=utf-8",
    "content-length": contentLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

function scopeFromHeaders(headers) {
  const service = singleHeader(headers["x-observability-service"]);
  const environment = singleHeader(headers["x-observability-environment"]);
  if (!service && !environment) return null;
  return { service, environment };
}

function singleHeader(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
