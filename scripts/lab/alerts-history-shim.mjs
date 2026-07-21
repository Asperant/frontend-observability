// Originally built as a workaround for what looked like a hard gap in this
// pinned OpenObserve build: `/api/v2/{org}/alerts/history` returned a
// stable but permanently empty shape for every alert, even seconds after a
// real, confirmed fire. The actual fix turned out to be a missing config
// flag, not a build limitation — see the "Alert history" row in
// docs/openobserve-v0.91-alert-capabilities.md and the
// ZO_USAGE_REPORT_TO_OWN_ORG / ZO_USAGE_REPORTING_ENABLED env vars now set
// on the `openobserve` service in infrastructure/docker/compose.yaml. The
// native History drawer works now. This shim is kept as a fallback for
// anyone running against a build/config where usage self-reporting isn't
// enabled, or who just wants alert evaluations to show up in the Logs
// Explorer instead of the Alerts page.
//
// It tails the container's own scheduler log lines
// (`openobserve::service::alerts::scheduler::handlers`) live via
// `docker compose logs -f --tail=0` (so a restart never replays old
// history) and re-ingests each parsed line as a structured record into a
// normal OpenObserve stream.
//
// Not coverage-gated: pure I/O, mirroring alerts/admin-client.mjs and
// alerts-install-starters.mjs's own rationale. The pure line-parsing
// contract lives in alerts/history-shim-parser.js and is 100%-covered there.

import { spawn } from "node:child_process";

import { readAdminAuthHeader, listAlerts } from "./alerts/admin-client.mjs";
import { parseSchedulerLine } from "./alerts/history-shim-parser.js";
import {
  assertExactLabToolchain,
  composeArgs,
  dockerDir,
  dockerEnv,
  log,
  logError,
} from "./common.mjs";
import { ingestJson } from "./streams/admin-client.mjs";

export const HISTORY_STREAM = "alert_eval_history";
const NAME_REFRESH_INTERVAL_MS = 30_000;
const FLUSH_INTERVAL_MS = 1_000;

async function resolveAlertNames(auth) {
  const alerts = await listAlerts(auth);
  return new Map(alerts.map((alert) => [alert.alert_id, alert.name]));
}

export async function runHistoryShim({ onRecord } = {}) {
  const auth = readAdminAuthHeader();
  let nameById = await resolveAlertNames(auth);
  let lastNameRefresh = Date.now();
  let pending = [];
  let flushTimer = null;

  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const result = await ingestJson(auth, HISTORY_STREAM, batch);
    if (!result.ok) {
      logError(`lab:alerts:history-shim: ingest failed with status ${result.status}`);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  }

  const child = spawn(
    "docker",
    composeArgs(["logs", "-f", "--no-log-prefix", "--tail=0", "openobserve"]),
    { cwd: dockerDir, env: dockerEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );

  let buffer = "";
  child.stdout.on("data", async (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const rawLine of lines) {
      const parsed = parseSchedulerLine(rawLine);
      if (!parsed) continue;
      if (
        !nameById.has(parsed.alert_id) &&
        Date.now() - lastNameRefresh > NAME_REFRESH_INTERVAL_MS
      ) {
        nameById = await resolveAlertNames(auth);
        lastNameRefresh = Date.now();
      }
      const record = { ...parsed, alert_name: nameById.get(parsed.alert_id) ?? parsed.alert_id };
      pending.push(record);
      onRecord?.(record);
      scheduleFlush();
    }
  });

  child.stderr.on("data", (chunk) => logError(chunk.toString("utf8").trimEnd()));

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      flush().finally(() => resolve(code));
    });
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  assertExactLabToolchain("lab:alerts:history-shim");
  log(`lab:alerts:history-shim: tailing openobserve scheduler logs -> stream "${HISTORY_STREAM}"`);
  log(
    "Open OpenObserve's Logs Explorer on this stream (with live tail on) to watch alert evaluations as they happen. Press Ctrl+C to stop.",
  );
  await runHistoryShim({ onRecord: (record) => log(`  ${record.alert_name}: ${record.status}`) });
}
