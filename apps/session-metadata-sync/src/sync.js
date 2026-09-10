import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SOURCE_STREAM = "_rumdata";
const TARGET_STREAM = "_sessionreplay";
const OPS_STREAM = "_frontend_observability_session_metadata_sync";
const METADATA_SCHEMA_VERSION = "1.0.0";
const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000;
const MAX_SESSION_DURATION_US = 8 * 60 * 60 * 1_000_000;
const UNSAFE_KEY_PATTERN =
  /(replay|segment|dom|html|video|canvas|input|form|body|header|cookie|authorization|token|password|private.?key|ip|email|usr|user|account|query|fragment)/i;
const SAFE_SOURCE_KEYS = Object.freeze([
  "_timestamp",
  "date",
  "type",
  "session_id",
  "view_id",
  "action_id",
  "error_id",
  "view",
  "action",
  "error",
  "frustration",
  "user_agent_user_agent_family",
  "user_agent_os_family",
  "user_agent_device_family",
  "browser",
  "os",
  "device",
  "device_type",
  "service",
  "env",
  "version",
  "tags",
  "source",
]);
const ALLOWED_METADATA_KEYS = Object.freeze([
  "_timestamp",
  "type",
  "metadata_schema_version",
  "session_id",
  "start",
  "end",
  "duration",
  "error_count",
  "view_count",
  "action_count",
  "frustration_count",
  "session_has_replay",
  "ip",
  "user_agent_user_agent_family",
  "user_agent_os_family",
  "device",
  "service",
  "env",
  "version",
  "tags",
  "source",
]);
const SOURCE_SELECT_CANDIDATES = Object.freeze([
  "_timestamp",
  "type",
  "session_id",
  "view_id",
  "action_id",
  "error_id",
  "user_agent_user_agent_family",
  "user_agent_os_family",
  "user_agent_device_family",
  "service",
  "env",
  "version",
  "source",
]);

export function createSessionMetadataSync(options) {
  const state = {
    initialized: false,
    lastAttemptAt: null,
    lastSuccessfulSyncAt: null,
    watermarkUs: readWatermark(options.watermarkPath),
    lagUs: null,
    unsafeRejections: 0,
    lastErrorCode: null,
  };

  async function syncOnce(now = new Date()) {
    state.lastAttemptAt = now.toISOString();
    try {
      const nowUs = now.getTime() * 1000;
      const startUs =
        state.watermarkUs > 0
          ? Math.max(0, state.watermarkUs - options.lookbackMs * 1000)
          : Math.max(0, nowUs - options.lookbackMs * 1000);
      const rows = await searchRumRows(options, startUs, nowUs);
      const aggregate = aggregateSessionMetadataRows(rows, nowUs);
      state.unsafeRejections += aggregate.unsafeRejections;
      if (aggregate.records.length > 0) {
        await ingestJson(options, TARGET_STREAM, aggregate.records);
      }
      if (aggregate.diagnostics.length > 0) {
        await ingestJson(options, OPS_STREAM, aggregate.diagnostics);
      }
      const maxTimestamp = rows.reduce(
        (max, row) => Math.max(max, Number(row._timestamp ?? 0)),
        state.watermarkUs,
      );
      if (maxTimestamp > state.watermarkUs) {
        writeWatermark(options.watermarkPath, maxTimestamp);
        state.watermarkUs = maxTimestamp;
      }
      state.initialized = true;
      state.lastSuccessfulSyncAt = now.toISOString();
      state.lastErrorCode = null;
      state.lagUs = nowUs - state.watermarkUs;
      return {
        ok: true,
        scanned: rows.length,
        written: aggregate.records.length,
        unsafeRejections: aggregate.unsafeRejections,
        watermarkUs: state.watermarkUs,
        lagUs: state.lagUs,
      };
    } catch (error) {
      state.lastErrorCode = classifySyncError(error);
      throw error;
    }
  }

  function ready() {
    return {
      ready: state.initialized,
      initialized: state.initialized,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
      watermarkUs: state.watermarkUs,
      lagUs: state.lagUs,
      unsafeRejections: state.unsafeRejections,
      lastErrorCode: state.lastErrorCode,
    };
  }

  return Object.freeze({ ready, syncOnce });
}

function classifySyncError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("openobserve_search_failed")) return "openobserve_search_failed";
  if (message.startsWith("openobserve_ingest_failed")) return "openobserve_ingest_failed";
  if (message.startsWith("missing required environment variable")) {
    return "missing_environment_variable";
  }
  return "session_metadata_sync_failed";
}

export function optionsFromEnv(env = process.env) {
  return {
    baseUrl: requiredEnv(env, "OPENOBSERVE_INTERNAL_URL"),
    readAuth: basicAuth(
      env.OPENOBSERVE_SESSION_READ_USERNAME ?? "default",
      readSecret(requiredEnv(env, "OPENOBSERVE_SESSION_READ_TOKEN_FILE")),
    ),
    writeAuth: basicAuth(
      env.OPENOBSERVE_SESSION_WRITE_USERNAME ?? "default",
      readSecret(requiredEnv(env, "OPENOBSERVE_SESSION_WRITE_TOKEN_FILE")),
    ),
    watermarkPath:
      env.SESSION_METADATA_WATERMARK_PATH ??
      "/var/lib/frontend-observability-session-metadata/watermark.json",
    lookbackMs: intEnv(env, "SESSION_METADATA_LOOKBACK_MS", DEFAULT_LOOKBACK_MS),
    limit: intEnv(env, "SESSION_METADATA_BATCH_LIMIT", 1000),
  };
}

export function aggregateSessionMetadataRows(rows, nowUs) {
  const sessions = new Map();
  const diagnostics = [];
  let unsafeRejections = 0;
  for (const row of rows) {
    const unsafe = findUnsafeKey(row);
    if (unsafe) {
      unsafeRejections += 1;
      diagnostics.push({
        _timestamp: nowUs,
        type: "session_metadata_rejection",
        reason: "unsafe_field",
        field: unsafe,
      });
      continue;
    }
    if (typeof row.session_id !== "string" || row.session_id.length === 0) continue;
    const session = sessions.get(row.session_id) ?? createEmptySession(row.session_id);
    const ts = Number(row._timestamp ?? row.date * 1000);
    if (Number.isFinite(ts) && ts > 0) {
      session.start = Math.min(session.start, ts);
      session.end = Math.max(session.end, ts);
    }
    addUnique(session.viewIds, row.view_id ?? row.view?.id);
    addUnique(session.actionIds, row.action_id ?? row.action?.id);
    addUnique(session.errorIds, row.error_id ?? row.error?.id);
    if (row.type === "error")
      addUnique(session.errorIds, row.error_id ?? row.error?.fingerprint ?? `${ts}`);
    if (row.type === "view") addUnique(session.viewIds, row.view_id ?? row.view?.id ?? `${ts}`);
    if (row.type === "action")
      addUnique(session.actionIds, row.action_id ?? row.action?.id ?? `${ts}`);
    if (isFrustration(row)) session.frustrationIds.add(String(row.action_id ?? row.error_id ?? ts));
    session.browser ||= canonical(row.user_agent_user_agent_family ?? row.browser);
    session.os ||= canonical(row.user_agent_os_family ?? row.os);
    session.device ||= canonical(row.device_type ?? row.device ?? row.user_agent_device_family);
    session.service ||= bounded(row.service);
    session.env ||= bounded(row.env);
    session.version ||= bounded(row.version);
    session.source ||= bounded(row.source);
    if (Array.isArray(row.tags))
      session.tags = row.tags.filter((tag) => typeof tag === "string").slice(0, 20);
    sessions.set(row.session_id, session);
  }
  const records = [...sessions.values()].map((session) => toRecord(session)).filter(Boolean);
  return { records, diagnostics, unsafeRejections };
}

function toRecord(session) {
  if (!Number.isFinite(session.start) || !Number.isFinite(session.end)) return null;
  const durationUs = Math.max(0, Math.min(session.end - session.start, MAX_SESSION_DURATION_US));
  // OpenObserve's native RUM Sessions feature reads `start`/`end` directly
  // from this stream (its own generated query is
  // `SELECT min(start) AS start_time, max(end) AS end_time, ... FROM
  // _sessionreplay GROUP BY session_id`) and renders "Time Spent" by
  // treating (end_time - start_time) as milliseconds -- not the
  // microseconds every _rumdata/_sessionreplay `_timestamp` uses elsewhere
  // in this pipeline. Writing raw microseconds here inflated every
  // displayed duration by exactly 1000x (live-observed: a real ~3.06s
  // session showed "51.06 min"; a session spanning ~32 real minutes showed
  // "22.40 days"). Convert once, at this storage boundary, so the
  // aggregation above keeps microsecond precision throughout.
  const startMs = Math.round(session.start / 1000);
  const durationMs = Math.round(durationUs / 1000);
  const record = {
    // The session's own last real activity time, in the microseconds
    // `_timestamp` convention every other stream uses here -- never the
    // sync cycle's "now". Native Sessions/Breadcrumbs/Tags all scope their
    // underlying queries to a time window around the session's *own*
    // start/end; syncOnce() runs on a periodic delay after the fact, so a
    // "now" `_timestamp` fell outside that window and those views found
    // zero rows even though this record existed (live-observed: OpenObserve
    // computed degenerate query bounds like start_time=-1/end_time=1 once
    // its own per-session metadata lookup came back empty).
    _timestamp: session.end,
    type: "session-metadata",
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    session_id: session.sessionId,
    start: startMs,
    end: startMs + durationMs,
    duration: durationMs,
    error_count: session.errorIds.size,
    view_count: session.viewIds.size,
    action_count: session.actionIds.size,
    frustration_count: session.frustrationIds.size,
    session_has_replay: false,
    ip: "redacted",
    user_agent_user_agent_family: session.browser || "Unknown",
    user_agent_os_family: session.os || "Unknown",
    device: session.device || "Unknown",
    service: session.service || null,
    env: session.env || null,
    version: session.version || null,
    tags: session.tags,
    source: session.source || "rum-metadata",
  };
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => ALLOWED_METADATA_KEYS.includes(key)),
  );
}

async function searchRumRows(options, startUs, endUs) {
  const availableFields = await getStreamFields(options, SOURCE_STREAM);
  const fields = SOURCE_SELECT_CANDIDATES.filter((field) => availableFields.has(field));
  if (!fields.includes("_timestamp") || !fields.includes("session_id")) return [];
  const sql = `select ${fields} from ${SOURCE_STREAM} limit ${options.limit}`;
  const response = await fetch(new URL("/api/default/_search?type=logs", options.baseUrl), {
    method: "POST",
    headers: { Authorization: options.readAuth, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: { sql, from: 0, size: options.limit, start_time: startUs, end_time: endUs },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `openobserve_search_failed:${response.status}:${detail.replace(/\s+/g, " ").slice(0, 200)}`,
    );
  }
  const body = await response.json();
  return Array.isArray(body.hits) ? body.hits : [];
}

async function getStreamFields(options, stream) {
  const response = await fetch(
    new URL(`/api/default/streams/${stream}/schema?type=logs`, options.baseUrl),
    {
      headers: { Authorization: options.readAuth, "Content-Type": "application/json" },
    },
  );
  if (!response.ok) return new Set(SOURCE_SELECT_CANDIDATES);
  const body = await response.json().catch(() => null);
  const fields = Array.isArray(body?.schema) ? body.schema : [];
  return new Set(fields.map((field) => field?.name).filter((name) => typeof name === "string"));
}

async function ingestJson(options, stream, records) {
  const response = await fetch(new URL(`/api/default/${stream}/_json`, options.baseUrl), {
    method: "POST",
    headers: { Authorization: options.writeAuth, "Content-Type": "application/json" },
    body: JSON.stringify(records),
  });
  if (!response.ok) throw new Error(`openobserve_ingest_failed:${stream}:${response.status}`);
}

function createEmptySession(sessionId) {
  return {
    sessionId,
    start: Number.POSITIVE_INFINITY,
    end: 0,
    errorIds: new Set(),
    viewIds: new Set(),
    actionIds: new Set(),
    frustrationIds: new Set(),
    tags: [],
  };
}

function findUnsafeKey(value) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_SOURCE_KEYS.includes(key) && UNSAFE_KEY_PATTERN.test(key)) return key;
    const nested = findUnsafeKey(child);
    if (nested) return `${key}.${nested}`;
  }
  return null;
}

function isFrustration(row) {
  return row.frustration === true || row.action?.frustration?.type || row.type === "long_task";
}

function addUnique(set, value) {
  if (typeof value === "string" && value.length > 0) set.add(value);
}

function canonical(value) {
  return bounded(value) || null;
}

function bounded(value) {
  return typeof value === "string" ? value.slice(0, 80) : null;
}

function readWatermark(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Number.isFinite(parsed.watermarkUs) ? parsed.watermarkUs : 0;
  } catch {
    return 0;
  }
}

function writeWatermark(path, watermarkUs) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ watermarkUs, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  const tempDir = join(dir, `.tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tempDir, { mode: 0o700 });
  const tempFile = join(tempDir, "write");
  let fd;
  try {
    fd = openSync(tempFile, "wx", 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempFile, path);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function fsyncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function readSecret(path) {
  return readFileSync(path, "utf8").trim();
}

function basicAuth(username, token) {
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

function intEnv(env, name, fallback) {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`invalid integer environment variable: ${name}`);
  return parsed;
}
