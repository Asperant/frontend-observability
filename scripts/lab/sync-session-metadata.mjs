// `pnpm lab:sessions:sync` (also run periodically by
// session-metadata-daemon.mjs) — populates `_sessionreplay` with
// derived, non-recording session summary metadata (start/end timestamp,
// browser, OS, ip, source) computed purely from `_rumdata`'s own
// already-sanitized fields, so OpenObserve's native RUM -> Sessions page
// can render a real, browsable session list. This is NOT session replay:
// no DOM/video/segment content is ever produced or stored anywhere by this
// project, the `/replay` ingestion route stays unallowlisted at the
// reverse proxy, and the vendor SDK never records or uploads anything
// (docs/session-replay-security-decision.md). `_sessionreplay` here holds
// only the same class of summary fields already visible in plaintext on
// every `_rumdata` row — never anything a real replay segment would carry.
//
// Field names are dictated by OpenObserve's own native Sessions-page query
// (reverse-engineered live, not guessed): `SELECT min(start), max(end),
// min(user_agent_user_agent_family), min(user_agent_os_family), min(ip),
// min(source) FROM "_sessionreplay" WHERE session_id IN (...) GROUP BY
// session_id`. MIN/MAX aggregation makes re-running this sync safe and
// idempotent-in-effect: duplicate/stale rows for the same session_id only
// ever converge toward the same true start/end, never regress it.
//
// _timestamp on every written row is "now" (sync time), not the session's
// own historical start — OpenObserve's `_search` always filters by
// `_timestamp` against the caller's selected time range (the Sessions
// page's own time picker), so a row stamped with its own old session start
// could silently fall outside whatever window the UI has selected and
// vanish from the enrichment query even though the session itself is still
// listed. Stamping "now" keeps every synced row visible in any reasonably
// recent UI window for as long as this script keeps re-syncing.

import {
  assertExactLabToolchain,
  log,
  logError,
} from "./common.mjs";
import { ingestJson, readAdminAuthHeader, search } from "./streams/admin-client.mjs";

const SOURCE_STREAM = "_rumdata";
const TARGET_STREAM = "_sessionreplay";
const SOURCE_WINDOW_MINUTES = 30;
const ROW_LIMIT = 150;

function buildQuery() {
  return (
    "select session_id, min(_timestamp) as start, max(_timestamp) as end, " +
    "min(user_agent_user_agent_family) as browser, min(user_agent_os_family) as os, " +
    "min(ip) as ip, min(source) as source " +
    `from ${SOURCE_STREAM} where session_id is not null group by session_id ` +
    `order by start desc limit ${ROW_LIMIT}`
  );
}

function buildRecord(hit, nowUs) {
  const record = {
    _timestamp: nowUs,
    type: "session-metadata",
    session_id: hit.session_id,
  };
  if (typeof hit.start === "number") record.start = hit.start;
  if (typeof hit.end === "number") record.end = hit.end;
  if (typeof hit.browser === "string" && hit.browser.length > 0) {
    record.user_agent_user_agent_family = hit.browser;
  }
  if (typeof hit.os === "string" && hit.os.length > 0) {
    record.user_agent_os_family = hit.os;
  }
  if (typeof hit.ip === "string" && hit.ip.length > 0) record.ip = hit.ip;
  if (typeof hit.source === "string" && hit.source.length > 0) record.source = hit.source;
  return record;
}

export async function syncSessionMetadata({ auth } = {}) {
  const resolvedAuth = auth ?? readAdminAuthHeader();
  const nowUs = Date.now() * 1000;
  const startUs = nowUs - SOURCE_WINDOW_MINUTES * 60 * 1000 * 1000;

  const result = await search(resolvedAuth, buildQuery(), { startUs, endUs: nowUs });
  if (result.status !== 200) {
    return { ok: false, status: result.status, synced: 0 };
  }

  const records = result.hits
    .filter((hit) => typeof hit.session_id === "string" && hit.session_id.length > 0)
    .map((hit) => buildRecord(hit, nowUs));

  if (records.length === 0) return { ok: true, synced: 0 };

  const ingestResult = await ingestJson(resolvedAuth, TARGET_STREAM, records);
  return {
    ok: ingestResult.ok,
    synced: ingestResult.ok ? records.length : 0,
    status: ingestResult.status,
  };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:sessions:sync");
    const result = await syncSessionMetadata();
    if (!result.ok) {
      logError(`lab:sessions:sync FAILED: status ${result.status}`);
      process.exit(1);
    }
    log(`lab:sessions:sync — synced ${result.synced} session(s).`);
  } catch (error) {
    logError(`lab:sessions:sync FAILED: ${error.message}`);
    process.exit(1);
  }
}
