import { createServer } from "node:http";

import { createSessionMetadataSync, optionsFromEnv } from "./sync.js";

const PORT = Number.parseInt(process.env.PORT ?? "4315", 10);
const INTERVAL_MS = Number.parseInt(process.env.SESSION_METADATA_SYNC_INTERVAL_MS ?? "60000", 10);
const service = createSessionMetadataSync(optionsFromEnv());

let lastError = null;

async function tick() {
  try {
    await service.syncOnce();
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
}

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
    const ready = service.ready();
    sendJson(res, lastError ? 503 : 200, { ...ready, lastError });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "session_metadata_sync_started", port: PORT }));
});

void tick();
setInterval(tick, INTERVAL_MS).unref();

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

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
