// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionMetadataSync } from "../src/sync.js";

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
