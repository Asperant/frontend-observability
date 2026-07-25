#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  aggregateSessionMetadataRows,
  createSessionMetadataSync,
} from "../../apps/session-metadata-sync/src/sync.js";
import {
  assertExactLabToolchain,
  generatedDir,
  log,
  logError,
  runDockerCompose,
} from "./common.mjs";
import { waitForHealthy } from "./wait.mjs";
import { ingestJson, readAdminAuthHeader, search } from "./streams/admin-client.mjs";

const RUN_ID = `session-metadata-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const SESSION_ID = `${RUN_ID}-session`;
const WATERMARK_PATH = join(generatedDir, `${RUN_ID}-watermark.json`);

function nowUs() {
  return Date.now() * 1000;
}

function baseRumRow(type, timestamp, extra = {}) {
  return {
    _timestamp: timestamp,
    date: Math.floor(timestamp / 1000),
    type,
    session_id: SESSION_ID,
    service: "browser-app",
    env: "lab",
    version: "2026.07.1",
    source: "browser",
    user_agent_user_agent_family: "Chromium",
    user_agent_os_family: "Linux",
    user_agent_device_family: "Desktop",
    test_run_id: RUN_ID,
    ...extra,
  };
}

async function pollSearch(auth, sql, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const endUs = nowUs();
    last = await search(auth, sql, { startUs: endUs - 10 * 60 * 1_000_000, endUs });
    if (last.status === 200 && (last.hits ?? []).length > 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return last;
}

function labSyncOptions() {
  const auth = readAdminAuthHeader();
  return {
    baseUrl: "http://127.0.0.1:5080",
    readAuth: auth,
    writeAuth: auth,
    watermarkPath: WATERMARK_PATH,
    lookbackMs: 10 * 60 * 1000,
    limit: 1000,
  };
}

function verifyUnsafeAggregation() {
  const result = aggregateSessionMetadataRows(
    [
      baseRumRow("view", nowUs(), {
        session_id: `${SESSION_ID}-unsafe`,
        dom_html: "<input value='secret'>",
        view_id: "unsafe-view",
      }),
    ],
    nowUs(),
  );
  if (result.records.length !== 0) throw new Error("unsafe DOM row produced metadata");
  if (result.unsafeRejections !== 1) throw new Error("unsafe DOM row was not rejected");
  if (result.diagnostics[0]?.reason !== "unsafe_field") {
    throw new Error("unsafe DOM row did not produce aggregate diagnostic");
  }
}

function verifyMetadataRows(rows) {
  if (rows.length < 2)
    throw new Error(`expected at-least-once duplicate metadata rows, got ${rows.length}`);
  const allowedKeys = new Set([
    "_timestamp",
    "action_count",
    "device",
    "duration",
    "end",
    "env",
    "error_count",
    "frustration_count",
    "ip",
    "metadata_schema_version",
    "service",
    "session_has_replay",
    "session_id",
    "source",
    "start",
    "type",
    "user_agent_os_family",
    "user_agent_user_agent_family",
    "version",
    "view_count",
  ]);
  const normalized = rows.map(({ _timestamp, ...row }) => row);
  const expected = {
    action_count: 1,
    device: "Desktop",
    env: "lab",
    error_count: 1,
    frustration_count: 1,
    ip: "redacted",
    metadata_schema_version: "1.0.0",
    service: "browser-app",
    session_has_replay: false,
    session_id: SESSION_ID,
    source: "browser",
    type: "session-metadata",
    user_agent_os_family: "Linux",
    user_agent_user_agent_family: "Chromium",
    version: "2026.07.1",
    view_count: 1,
  };
  for (const row of normalized) {
    for (const key of Object.keys(row)) {
      if (!allowedKeys.has(key)) throw new Error(`metadata row contains unexpected field: ${key}`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (row[key] !== value) throw new Error(`metadata ${key} mismatch: ${row[key]} !== ${value}`);
    }
    const duration = Number(row.duration);
    if (!Number.isFinite(duration) || duration < 0 || duration > 8 * 60 * 60 * 1_000_000) {
      throw new Error(`metadata duration is not bounded: ${row.duration}`);
    }
    if (
      JSON.stringify(row).match(
        /dom_html|<input|cookie=|authorization|bearer|token=|password|private key|query=|fragment=|@example\.com|\b(?:\d{1,3}\.){3}\d{1,3}\b/i,
      )
    ) {
      throw new Error("metadata row contains unsafe field/value text");
    }
  }
  const canonical = JSON.stringify(normalized[0]);
  for (const row of normalized.slice(1)) {
    if (JSON.stringify(row) !== canonical) {
      throw new Error("metadata rows are not deterministic across duplicate syncs");
    }
  }
}

async function verifyServiceRestart() {
  runDockerCompose(["restart", "session-metadata-sync"]);
  const healthy = await waitForHealthy({ services: ["session-metadata-sync"], timeoutMs: 90_000 });
  if (!healthy.healthy)
    throw new Error("session-metadata-sync did not return healthy after restart");
  const ready = runDockerCompose(
    [
      "exec",
      "-T",
      "session-metadata-sync",
      "node",
      "-e",
      "fetch('http://127.0.0.1:4315/readyz').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})",
    ],
    { capture: true },
  );
  if (ready.status !== 0) throw new Error(`session-metadata-sync readyz failed: ${ready.stderr}`);
}

export async function verifySessionMetadata() {
  const auth = readAdminAuthHeader();
  rmSync(WATERMARK_PATH, { force: true });
  verifyUnsafeAggregation();

  const baseTs = nowUs() - 20_000_000;
  const rows = [
    baseRumRow("view", baseTs, { view_id: `${RUN_ID}-view` }),
    baseRumRow("view", baseTs + 1_000_000, { view_id: `${RUN_ID}-view` }),
    baseRumRow("action", baseTs + 2_000_000, { action_id: `${RUN_ID}-action` }),
    baseRumRow("action", baseTs + 3_000_000, { action_id: `${RUN_ID}-action` }),
    baseRumRow("error", baseTs + 4_000_000, { error_id: `${RUN_ID}-error` }),
    baseRumRow("error", baseTs + 5_000_000, { error_id: `${RUN_ID}-error` }),
    baseRumRow("long_task", baseTs + 6_000_000),
  ];
  const ingest = await ingestJson(auth, "_rumdata", rows);
  if (!ingest.ok) throw new Error(`RUM canary ingest failed (${ingest.status})`);

  const first = await createSessionMetadataSync(labSyncOptions()).syncOnce();
  if (!first.ok || first.written < 1)
    throw new Error(`first sync wrote no records: ${JSON.stringify(first)}`);
  if (!existsSync(WATERMARK_PATH)) throw new Error("watermark file was not persisted");
  const persistedWatermark = JSON.parse(readFileSync(WATERMARK_PATH, "utf8")).watermarkUs;
  if (!Number.isFinite(persistedWatermark) || persistedWatermark <= 0) {
    throw new Error("watermark file did not contain a positive watermark");
  }

  const second = await createSessionMetadataSync(labSyncOptions()).syncOnce();
  if (!second.ok || second.watermarkUs < persistedWatermark) {
    throw new Error(
      `restart/idempotency sync moved watermark backwards: ${JSON.stringify(second)}`,
    );
  }

  const metadata = await pollSearch(
    auth,
    `select * from _sessionreplay where session_id = '${SESSION_ID}' order by _timestamp desc limit 5`,
  );
  if (metadata?.status !== 200) throw new Error(`metadata search failed (${metadata?.status})`);
  verifyMetadataRows(metadata.hits ?? []);

  await verifyServiceRestart();

  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    duplicateMetadataRows: metadata.hits.length,
    first,
    second,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("test:session-metadata");
    const result = await verifySessionMetadata();
    log(`test:session-metadata PASSED — ${JSON.stringify(result)}`);
  } catch (error) {
    logError(`test:session-metadata FAILED: ${error.message}`);
    process.exit(1);
  }
}
