#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { generatedDir } from "./common.mjs";
import { syncSessionMetadata } from "./sync-session-metadata.mjs";

const SYNC_INTERVAL_MS = 60 * 1000;
const logPath = join(generatedDir, "session-metadata-daemon.log");

function logLine(message) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best-effort lab wrapper logging only.
  }
}

async function tick() {
  try {
    const result = await syncSessionMetadata();
    logLine(`synced ${result.written} session(s) (ok=${result.ok})`);
  } catch (error) {
    logLine(`sync failed: ${error.message}`);
  }
}

process.on("SIGTERM", () => {
  logLine("received SIGTERM, exiting");
  process.exit(0);
});

logLine(`session-metadata-daemon started (pid=${process.pid}, interval=${SYNC_INTERVAL_MS}ms)`);
void tick();
setInterval(tick, SYNC_INTERVAL_MS);
