import { createServer } from "node:http";

import { createSessionMetadataSync, optionsFromEnv } from "./sync.js";
import { createTickScheduler } from "./scheduler.js";

const PORT = Number.parseInt(process.env.PORT ?? "4315", 10);
const INTERVAL_MS = Number.parseInt(process.env.SESSION_METADATA_SYNC_INTERVAL_MS ?? "60000", 10);
const service = createSessionMetadataSync(optionsFromEnv());
const scheduler = createTickScheduler(() => service.syncOnce());

const server = createServer((req, res) => {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (req.url === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (req.url === "/readyz") {
    const state = service.ready();
    sendJson(res, state.ready ? 200 : 503, state);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "session_metadata_sync_started", port: PORT }));
});

void scheduler.tick();
const intervalHandle = setInterval(() => void scheduler.tick(), INTERVAL_MS).unref();

function sendJson(res, statusCode, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function shutdown(signal) {
  scheduler.stop();
  clearInterval(intervalHandle);
  console.log(JSON.stringify({ event: "session_metadata_sync_shutdown", signal }));
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
