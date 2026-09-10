import { beforeEach, describe, expect, it, vi } from "vitest";

import { createConsentEpoch } from "../src/correlation/create-epoch.js";
import {
  clearCorrelationContext,
  createCorrelationContext,
  grantCorrelationEpoch,
  snapshotCorrelation,
  updateCorrelationCapabilities,
} from "../src/correlation/correlation-context.js";
import { createCorrelationCapabilities } from "../src/correlation/capabilities.js";
import { enrichLogEvent } from "../src/correlation/enrich-log-event.js";
import { createMetadata, enrichRumEvent } from "../src/correlation/enrich-rum-event.js";
import {
  extractNativeContext,
  extractNativeContextFromSdk,
} from "../src/correlation/extract-native-context.js";
import {
  isReservedCorrelationKey,
  stripReservedFields,
} from "../src/correlation/reserved-fields.js";
import { validateCorrelationId } from "../src/correlation/validate-correlation-id.js";
import { createCounters, snapshotCorrelationCounters } from "../src/diagnostics/counters.js";
import { recordCorrelation } from "../src/correlation/counters.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("correlation epoch and ID validation", () => {
  it("creates a controlled memory-only epoch with getRandomValues", () => {
    const epoch = createConsentEpoch();
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);
  });

  it("fails closed when crypto.getRandomValues is unavailable", () => {
    vi.stubGlobal("crypto", {});
    expect(createConsentEpoch()).toBeNull();
    vi.unstubAllGlobals();
  });

  it.each([
    ["abc-123._:x", true],
    ["", false],
    ["x".repeat(129), false],
    ["line\nbreak", false],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", false],
    [{ id: "abc" }, false],
    [["abc"], false],
  ])("validates correlation ID %p as %p", (value, expected) => {
    expect(validateCorrelationId(value)).toBe(expected);
  });

  it("rotates and clears consent epochs without exposing IDs in status", () => {
    const context = createCorrelationContext();
    expect(context.epochId).toBeNull();
    expect(grantCorrelationEpoch(context)).toBe(true);
    const first = context.epochId;
    clearCorrelationContext(context);
    expect(context.epochId).toBeNull();
    expect(grantCorrelationEpoch(context)).toBe(true);
    expect(context.epochId).not.toBe(first);
    const snapshot = snapshotCorrelation(context, snapshotCorrelationCounters(createCounters()), {
      reasonCode: "NONE",
    });
    expect(JSON.stringify(snapshot)).not.toContain(context.epochId);
    expect(snapshot.schemaVersion).toBe(1);
  });

  it("reports capabilities from booleans only", () => {
    expect(
      createCorrelationCapabilities({ epoch: true, nativeContext: true, logs: false }),
    ).toEqual({
      epoch: true,
      session: true,
      view: true,
      action: true,
      crossStream: false,
    });
    const context = createCorrelationContext();
    updateCorrelationCapabilities(context, { epoch: true, nativeContext: false, logs: true });
    expect(context.capabilities.crossStream).toBe(true);
    expect(context.capabilities.session).toBe(false);
    expect(grantCorrelationEpoch(null)).toBe(false);
    expect(() => clearCorrelationContext(null)).not.toThrow();
    expect(() => updateCorrelationCapabilities(null, {})).not.toThrow();
    const fallbackSnapshot = snapshotCorrelation(null, snapshotCorrelationCounters(null), null);
    expect(fallbackSnapshot).toMatchObject({
      state: "unavailable",
      lastReasonCode: "NONE",
    });
    expect(recordCorrelation(null, "enriched")).toBe(false);
    expect(recordCorrelation(createCounters(), "unknown")).toBe(false);
  });
});

describe("reserved-field stripping", () => {
  it.each([
    "frontend-observability",
    "correlation.id",
    "session_id",
    "view",
    "action",
    "trace",
    "span",
    "_dd",
  ])("recognizes %s as reserved", (key) => {
    expect(isReservedCorrelationKey(key)).toBe(true);
  });

  it("removes reserved fields from user context without traversing nested objects", () => {
    const counters = createCounters();
    const result = stripReservedFields(
      {
        safe: "yes",
        "frontend-observability": "forge",
        nested: { "frontend-observability": "left alone" },
      },
      { counters },
    );
    expect(result.value).toEqual({
      safe: "yes",
      nested: { "frontend-observability": "left alone" },
    });
    expect(result.removed).toBe(true);
    expect(snapshotCorrelationCounters(counters).reservedFieldRemoved).toBe(1);
  });

  it.each([null, undefined, "x", ["session"]])("leaves non-plain contexts alone: %p", (value) => {
    expect(stripReservedFields(value).value).toBe(value);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "recognizes the reserved object-shaped key %p as reserved",
    (key) => {
      expect(isReservedCorrelationKey(key)).toBe(true);
    },
  );

  it("strips an own __proto__ key instead of letting it change the result's prototype", () => {
    const attacker = JSON.parse('{"__proto__": null, "safe": "ok"}');
    const result = stripReservedFields(attacker);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(result.value).toEqual({ safe: "ok" });
    expect(result.removed).toBe(true);
  });
});

describe("native context extraction", () => {
  it("extracts valid native event IDs and ignores invalid values", () => {
    const counters = createCounters();
    const result = extractNativeContext(
      {
        session: { id: "session-1" },
        view: { id: "view-1" },
        action: { id: "bad\nid" },
      },
      { user_action: { id: "action-1" } },
      { counters },
    );
    expect(result).toMatchObject({
      sessionId: "session-1",
      viewId: "view-1",
      actionId: "action-1",
      reasonCode: "CORRELATION_NATIVE_ID_INVALID",
    });
    expect(snapshotCorrelationCounters(counters).invalidNativeId).toBe(1);
  });

  it("uses the SDK internal context API when available and isolates throws", () => {
    expect(
      extractNativeContextFromSdk(() => ({
        session_id: "session-2",
        view: { id: "view-2" },
        user_action: { id: "action-2" },
      })),
    ).toEqual({ sessionId: "session-2", viewId: "view-2", actionId: "action-2" });

    const counters = createCounters();
    expect(
      extractNativeContextFromSdk(
        () => {
          throw new Error("sdk internal context failed");
        },
        Date.now(),
        { counters },
      ),
    ).toEqual({});
    expect(snapshotCorrelationCounters(counters).unavailable).toBe(1);
    expect(extractNativeContextFromSdk(null)).toEqual({});
    expect(extractNativeContextFromSdk(() => null)).toEqual({});
  });
});

describe("RUM and log enrichment", () => {
  it("enriches a RUM action with epoch, session, view and action metadata", () => {
    const counters = createCounters();
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    const event = {
      type: "action",
      context: { safe: "ok" },
      session: { id: "session-1" },
      view: { id: "view-1" },
      action: { id: "action-1" },
    };
    expect(enrichRumEvent(event, undefined, correlation, { counters })).toBeUndefined();
    expect(event.context).toMatchObject({
      safe: "ok",
      "frontend-observability.correlation.schema_version": "1",
      "frontend-observability.correlation.epoch_id": correlation.epochId,
      "frontend-observability.correlation.session_id": "session-1",
      "frontend-observability.correlation.view_id": "view-1",
      "frontend-observability.correlation.action_id": "action-1",
    });
    expect(snapshotCorrelationCounters(counters).enriched).toBe(1);
  });

  it("partially enriches without guessing a missing action", () => {
    const counters = createCounters();
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    const event = {
      type: "action",
      context: { correlation: "forge" },
      session: { id: "session-1" },
      view: { id: "view-1" },
      action: {},
    };
    expect(enrichRumEvent(event, {}, correlation, { counters })).toBeUndefined();
    expect(event.context).not.toHaveProperty("correlation");
    expect(event.context).not.toHaveProperty("frontend-observability.correlation.action_id");
    expect(snapshotCorrelationCounters(counters)).toMatchObject({
      partial: 1,
      reservedFieldRemoved: 1,
    });
  });

  it("enriches a view without requiring an action ID", () => {
    const counters = createCounters();
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    const event = {
      type: "view",
      session: { id: "session-view" },
      view: { id: "view-view" },
    };
    expect(enrichRumEvent(event, {}, correlation, { counters })).toBeUndefined();
    expect(event.context["frontend-observability.correlation.session_id"]).toBe("session-view");
    expect(event.context["frontend-observability.correlation.view_id"]).toBe("view-view");
    expect(snapshotCorrelationCounters(counters).enriched).toBe(1);
  });

  it("partially enriches a RUM event without native session/view and omits invalid metadata", () => {
    const counters = createCounters();
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    const event = { type: "resource" };
    expect(enrichRumEvent(event, {}, correlation, { counters })).toBeUndefined();
    expect(event.context).toEqual({
      "frontend-observability.correlation.schema_version": "1",
      "frontend-observability.correlation.epoch_id": correlation.epochId,
    });
    expect(createMetadata("bad\nid", { sessionId: {}, viewId: [], actionId: "ok" })).toEqual({
      "frontend-observability.correlation.schema_version": "1",
      "frontend-observability.correlation.action_id": "ok",
    });
    expect(snapshotCorrelationCounters(counters).partial).toBe(1);
  });

  it("drops enrichment fail-closed when no epoch or an unexpected mutation failure occurs", () => {
    const counters = createCounters();
    expect(enrichRumEvent({ type: "view" }, {}, createCorrelationContext(), { counters })).toBe(
      false,
    );
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    const frozenEvent = Object.freeze({ type: "view", context: {} });
    expect(enrichRumEvent(frozenEvent, {}, correlation, { counters })).toBe(false);
    expect(snapshotCorrelationCounters(counters).unavailable).toBe(2);
  });

  it("enriches logs from the SDK internal context API and strips forged fields", () => {
    const counters = createCounters();
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    const event = { date: Date.now(), context: { trace: "forge", safe: true } };
    expect(
      enrichLogEvent(event, {}, correlation, {
        counters,
        getInternalContext: () => ({
          session_id: "session-log",
          view: { id: "view-log" },
        }),
      }),
    ).toBeUndefined();
    expect(event.context).toMatchObject({
      safe: true,
      "frontend-observability.correlation.epoch_id": correlation.epochId,
      "frontend-observability.correlation.session_id": "session-log",
      "frontend-observability.correlation.view_id": "view-log",
    });
    expect(event.context).not.toHaveProperty("trace");
  });

  it("uses only epoch for logs when native context is unavailable", () => {
    const counters = createCounters();
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    const event = {};
    expect(enrichLogEvent(event, {}, correlation, { counters })).toBeUndefined();
    expect(event.context).toEqual({
      "frontend-observability.correlation.schema_version": "1",
      "frontend-observability.correlation.epoch_id": correlation.epochId,
    });
    expect(snapshotCorrelationCounters(counters).partial).toBe(1);
  });

  it("drops log enrichment fail-closed on unavailable context or mutation failure", () => {
    const counters = createCounters();
    expect(enrichLogEvent({}, {}, createCorrelationContext(), { counters })).toBe(false);
    const correlation = createCorrelationContext();
    grantCorrelationEpoch(correlation);
    expect(enrichLogEvent(Object.freeze({ context: {} }), {}, correlation, { counters })).toBe(
      false,
    );
    expect(snapshotCorrelationCounters(counters).unavailable).toBe(2);
  });
});
