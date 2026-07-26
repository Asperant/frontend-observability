// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aggregateSessionMetadataRows, createSessionMetadataSync } from "../src/sync.js";

const SCHEMA_FIELDS = [
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
];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeOptions(watermarkPath, fetchImpl) {
  vi.stubGlobal("fetch", fetchImpl);
  return {
    baseUrl: "http://openobserve.invalid",
    readAuth: "Basic dGVzdA==",
    writeAuth: "Basic dGVzdA==",
    watermarkPath,
    lookbackMs: 10 * 60 * 1000,
    limit: 1000,
  };
}

describe("createSessionMetadataSync readiness state machine", () => {
  let dir;
  let watermarkPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-metadata-test-"));
    watermarkPath = join(dir, "watermark.json");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not ready at fresh startup, before any sync has run", () => {
    const service = createSessionMetadataSync(
      makeOptions(watermarkPath, async () => jsonResponse(200, { schema: [] })),
    );
    const state = service.ready();
    expect(state.ready).toBe(false);
    expect(state.initialized).toBe(false);
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  it("becomes ready after a successful sync that scans zero rows", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith("/schema")) {
        return jsonResponse(200, { schema: SCHEMA_FIELDS.map((name) => ({ name })) });
      }
      if (target.pathname.endsWith("/_search")) {
        return jsonResponse(200, { hits: [] });
      }
      throw new Error(`unexpected fetch: ${target.pathname}`);
    });
    const service = createSessionMetadataSync(makeOptions(watermarkPath, fetchImpl));

    const result = await service.syncOnce();

    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(0);
    const state = service.ready();
    expect(state.ready).toBe(true);
    expect(state.initialized).toBe(true);
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
  });

  it("becomes ready after a successful sync that writes records", async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith("/schema")) {
        return jsonResponse(200, { schema: SCHEMA_FIELDS.map((name) => ({ name })) });
      }
      if (target.pathname.endsWith("/_search")) {
        return jsonResponse(200, {
          hits: [{ _timestamp: now * 1000, type: "view", session_id: "s1", view_id: "v1" }],
        });
      }
      if (target.pathname.endsWith("/_json")) {
        return jsonResponse(200, {});
      }
      throw new Error(`unexpected fetch: ${target.pathname}`);
    });
    const service = createSessionMetadataSync(makeOptions(watermarkPath, fetchImpl));

    const result = await service.syncOnce();

    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(service.ready().ready).toBe(true);
  });

  it("a persisted watermark file alone does not make the service ready", () => {
    const priorWatermark = { watermarkUs: Date.now() * 1000, updatedAt: new Date().toISOString() };
    writeFileSync(watermarkPath, JSON.stringify(priorWatermark));

    const service = createSessionMetadataSync(
      makeOptions(watermarkPath, async () => jsonResponse(200, { schema: [] })),
    );
    const state = service.ready();
    expect(state.ready).toBe(false);
    expect(state.watermarkUs).toBe(priorWatermark.watermarkUs);
  });

  it("a missing or malformed watermark file does not crash startup and leaves the service unready", () => {
    const service = createSessionMetadataSync(
      makeOptions(join(dir, "does-not-exist.json"), async () => jsonResponse(200, { schema: [] })),
    );
    expect(() => service.ready()).not.toThrow();
    expect(service.ready().ready).toBe(false);
    expect(service.ready().watermarkUs).toBe(0);
  });

  it("records a bounded lastErrorCode and stays unready when OpenObserve is unavailable", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith("/schema")) {
        return jsonResponse(200, { schema: SCHEMA_FIELDS.map((name) => ({ name })) });
      }
      if (target.pathname.endsWith("/_search")) {
        return jsonResponse(503, "");
      }
      throw new Error(`unexpected fetch: ${target.pathname}`);
    });
    const service = createSessionMetadataSync(makeOptions(watermarkPath, fetchImpl));

    await expect(service.syncOnce()).rejects.toThrow();
    const state = service.ready();
    expect(state.ready).toBe(false);
    expect(state.lastErrorCode).toBe("openobserve_search_failed");
    // The bounded error code must never contain the raw response body.
    expect(state.lastErrorCode).not.toMatch(/[<>{}]/);
  });

  it("becomes ready again once a prior failure is followed by a successful sync", async () => {
    let fail = true;
    const fetchImpl = vi.fn(async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith("/schema")) {
        return jsonResponse(200, { schema: SCHEMA_FIELDS.map((name) => ({ name })) });
      }
      if (target.pathname.endsWith("/_search")) {
        if (fail) return jsonResponse(503, "");
        return jsonResponse(200, { hits: [] });
      }
      throw new Error(`unexpected fetch: ${target.pathname}`);
    });
    const service = createSessionMetadataSync(makeOptions(watermarkPath, fetchImpl));

    await expect(service.syncOnce()).rejects.toThrow();
    expect(service.ready().ready).toBe(false);

    fail = false;
    const result = await service.syncOnce();
    expect(result.ok).toBe(true);
    expect(service.ready().ready).toBe(true);
    expect(service.ready().lastErrorCode).toBeNull();
  });
});

describe("aggregateSessionMetadataRows", () => {
  // Regression coverage for a live-observed bug: OpenObserve's native RUM
  // Sessions feature reads `start`/`end` straight out of _sessionreplay and
  // renders "Time Spent" by treating their difference as milliseconds, but
  // _rumdata._timestamp (and this aggregation's own internal math) is in
  // microseconds throughout this pipeline. A real ~3.06s session used to be
  // written with duration=3063444 (raw microseconds) and rendered as
  // "51.06 min"; a session spanning ~32 real minutes rendered as
  // "22.40 days".
  it("writes start/end/duration in milliseconds, not the source microseconds", () => {
    const startUs = 1_700_000_000_000_000;
    const endUs = startUs + 3_063_444; // ~3.06 real seconds of activity
    const rows = [
      { _timestamp: startUs, type: "view", session_id: "s1", view_id: "v1" },
      { _timestamp: endUs, type: "action", session_id: "s1", action_id: "a1" },
    ];

    const { records } = aggregateSessionMetadataRows(rows, endUs + 1_000_000);

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.duration).toBe(3063);
    expect(record.start).toBe(Math.round(startUs / 1000));
    expect(record.end).toBe(record.start + record.duration);
  });

  // Regression coverage for a second, compounding live-observed bug: this
  // record's `_timestamp` used to be the sync cycle's own "now" rather than
  // the session's real activity time. OpenObserve's native Sessions page,
  // Breadcrumbs tab and Tags tab all scope their underlying queries to a
  // time window around the session's *own* start/end; syncOnce() runs on a
  // periodic delay after the fact, so a "now" `_timestamp` fell outside
  // that window and every one of those views found zero rows even though
  // this record existed and _rumdata held the real breadcrumb events.
  it("stamps _timestamp with the session's own last activity time, not the sync cycle's now", () => {
    const startUs = 1_700_000_000_000_000;
    const endUs = startUs + 5_000_000;
    const syncRanTenRealMinutesLaterUs = endUs + 10 * 60 * 1_000_000;
    const rows = [
      { _timestamp: startUs, type: "view", session_id: "s1", view_id: "v1" },
      { _timestamp: endUs, type: "view", session_id: "s1", view_id: "v2" },
    ];

    const { records } = aggregateSessionMetadataRows(rows, syncRanTenRealMinutesLaterUs);

    expect(records).toHaveLength(1);
    expect(records[0]._timestamp).toBe(endUs);
    expect(records[0]._timestamp).not.toBe(syncRanTenRealMinutesLaterUs);
  });

  it("clamps an implausibly long span to MAX_SESSION_DURATION_US before converting to milliseconds", () => {
    const startUs = 1_700_000_000_000_000;
    const endUs = startUs + 24 * 60 * 60 * 1_000_000; // 24 real hours
    const rows = [
      { _timestamp: startUs, type: "view", session_id: "s1", view_id: "v1" },
      { _timestamp: endUs, type: "view", session_id: "s1", view_id: "v2" },
    ];

    const { records } = aggregateSessionMetadataRows(rows, endUs);

    expect(records[0].duration).toBe(8 * 60 * 60 * 1000); // capped at 8 hours, in ms
  });
});
