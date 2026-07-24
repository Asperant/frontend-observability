import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { generatedDir } from "./common.mjs";
import { syncSessionMetadata } from "./sync-session-metadata.mjs";

// Keeps `_sessionreplay` populated with fresh derived session metadata (see
// sync-session-metadata.mjs for what this is and, just as importantly, what
// it deliberately is not) for as long as the lab stays up. A 60s interval
// comfortably re-freshens every synced row's _timestamp well inside even the
// native Sessions page's shortest realistic time-range selection, so the
// enrichment query never finds a stale-out-of-window row. Spawned by
// lab:up, mirrors runtime-control-refresh-daemon.mjs's own pattern exactly
// (detached, PID-file-tracked, stopped by lab:down/lab:purge).
const SYNC_INTERVAL_MS = 60 * 1000;
const logPath = join(generatedDir, "session-metadata-daemon.log");

function logLine(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    /* best-effort logging only; never let a log write crash the daemon */
  }
}

async function tick() {
  try {
    const result = await syncSessionMetadata();
    logLine(`synced ${result.synced} session(s) (ok=${result.ok}, status=${result.status ?? 200})`);
  } catch (error) {
    logLine(`sync failed: ${error.message}`);
  }
}

process.on("SIGTERM", () => {
  logLine("received SIGTERM, exiting");
  process.exit(0);
});

logLine(`session-metadata-daemon started (pid=${process.pid}, interval=${SYNC_INTERVAL_MS}ms)`);
tick();
setInterval(tick, SYNC_INTERVAL_MS);
