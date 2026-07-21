import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { generatedDir } from "./common.mjs";
import { refreshRuntimeControl } from "./generate-runtime-control.mjs";

// The runtime-control document's TTL is capped at 10 minutes (see
// packages/browser-observability/src/runtime-control/constants.js,
// MAX_CONTROL_TTL_MS) by design — the browser SDK must fail closed once it
// goes stale. up.mjs only stamps it once, at lab:up time, so any lab left
// running past that window previously went permanently dark: the SDK
// dropped 100% of telemetry with reasonCode RUNTIME_CONTROL_UNAVAILABLE and
// no visible error anywhere. This detached process is spawned by lab:up to
// keep re-stamping the document well inside its own TTL for as long as the
// lab stays up, so a normal exploratory session (minutes to hours) never
// silently loses data. It is stopped by lab:down/lab:purge via its PID file.
const REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const logPath = join(generatedDir, "runtime-control-daemon.log");

function logLine(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    /* best-effort logging only; never let a log write crash the daemon */
  }
}

function tick() {
  try {
    const document = refreshRuntimeControl();
    logLine(`refreshed: revision=${document.revision} expiresAt=${document.expiresAt}`);
  } catch (error) {
    logLine(`refresh failed: ${error.message}`);
  }
}

process.on("SIGTERM", () => {
  logLine("received SIGTERM, exiting");
  process.exit(0);
});

logLine(`runtime-control-refresh-daemon started (pid=${process.pid}, interval=${REFRESH_INTERVAL_MS}ms)`);
tick();
setInterval(tick, REFRESH_INTERVAL_MS);
