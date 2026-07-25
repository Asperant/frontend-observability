// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  controlStateChanged,
  isConsumptionAllowed,
  isDeliveryReady,
  readControlState,
} from "../src/control-state.js";

describe("readControlState", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delivery-control-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is fail-closed HOLD when DELIVERY_CONTROL_FILE is unset", () => {
    expect(readControlState(undefined)).toEqual({
      ready: false,
      held: true,
      reason: "control_env_missing",
    });
    expect(readControlState("")).toEqual({
      ready: false,
      held: true,
      reason: "control_env_missing",
    });
  });

  it("is fail-closed HOLD when the file does not exist", () => {
    const result = readControlState(join(dir, "does-not-exist.json"));
    expect(result).toEqual({ ready: false, held: true, reason: "control_file_missing" });
  });

  it("is fail-closed HOLD when the file is unreadable", () => {
    const path = join(dir, "no-read-perm.json");
    writeFileSync(path, JSON.stringify({ hold: false }));
    chmodSync(path, 0o000);
    try {
      const result = readControlState(path);
      // Running as root (common in CI containers) bypasses POSIX permission
      // bits entirely, so this environment cannot exercise EACCES; skip
      // rather than assert a false failure.
      if (process.getuid && process.getuid() === 0) {
        expect(result.ready).toBe(true);
        return;
      }
      expect(result).toEqual({ ready: false, held: true, reason: "control_file_unreadable" });
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("is fail-closed HOLD when the file contains malformed JSON", () => {
    const path = join(dir, "malformed.json");
    writeFileSync(path, "{not json");
    expect(readControlState(path)).toEqual({
      ready: false,
      held: true,
      reason: "control_file_malformed",
    });
  });

  it("is fail-closed HOLD when the document is not an object", () => {
    const path = join(dir, "array.json");
    writeFileSync(path, JSON.stringify([1, 2, 3]));
    expect(readControlState(path)).toEqual({
      ready: false,
      held: true,
      reason: "control_document_invalid",
    });
  });

  it("is fail-closed HOLD when hold is not a boolean", () => {
    const path = join(dir, "invalid-hold.json");
    writeFileSync(path, JSON.stringify({ hold: "yes" }));
    expect(readControlState(path)).toEqual({
      ready: false,
      held: true,
      reason: "control_document_invalid",
    });
  });

  it("is ready and held for a valid hold=true document", () => {
    const path = join(dir, "hold-true.json");
    writeFileSync(path, JSON.stringify({ hold: true }));
    expect(readControlState(path)).toEqual({
      ready: true,
      held: true,
      reason: "hold_requested",
    });
  });

  it("is ready and not held for a valid hold=false document", () => {
    const path = join(dir, "hold-false.json");
    writeFileSync(path, JSON.stringify({ hold: false }));
    expect(readControlState(path)).toEqual({
      ready: true,
      held: false,
      reason: "hold_clear",
    });
  });

  it("never includes raw document content in the result", () => {
    const path = join(dir, "with-secret.json");
    writeFileSync(path, JSON.stringify({ hold: false, secretLookingField: "sk_live_abc123" }));
    const result = readControlState(path);
    expect(JSON.stringify(result)).not.toContain("sk_live_abc123");
  });
});

describe("isConsumptionAllowed / isDeliveryReady", () => {
  const invalidStartup = { ready: false, held: true, reason: "control_not_evaluated" };
  const invalidMissing = { ready: false, held: true, reason: "control_file_missing" };
  const validHoldTrue = { ready: true, held: true, reason: "hold_requested" };
  const validHoldFalse = { ready: true, held: false, reason: "hold_clear" };

  it("startup default (unevaluated control) is fail-closed: not consuming, not ready", () => {
    expect(isConsumptionAllowed(invalidStartup)).toBe(false);
    expect(isDeliveryReady(true, invalidStartup)).toBe(false);
  });

  it("an invalid/missing control state never allows consumption or readiness", () => {
    expect(isConsumptionAllowed(invalidMissing)).toBe(false);
    expect(isDeliveryReady(true, invalidMissing)).toBe(false);
  });

  it("a valid hold=true document blocks consumption and readiness even though the control state itself is healthy", () => {
    expect(isConsumptionAllowed(validHoldTrue)).toBe(false);
    expect(isDeliveryReady(true, validHoldTrue)).toBe(false);
  });

  it("a valid hold=false document allows consumption, and readiness also requires a healthy connection", () => {
    expect(isConsumptionAllowed(validHoldFalse)).toBe(true);
    expect(isDeliveryReady(true, validHoldFalse)).toBe(true);
    expect(isDeliveryReady(false, validHoldFalse)).toBe(false);
  });
});

describe("controlStateChanged", () => {
  it("detects a valid -> invalid transition", () => {
    const from = { ready: true, held: false, reason: "hold_clear" };
    const to = { ready: false, held: true, reason: "control_file_malformed" };
    expect(controlStateChanged(from, to)).toBe(true);
  });

  it("detects an invalid -> valid transition", () => {
    const from = { ready: false, held: true, reason: "control_file_missing" };
    const to = { ready: true, held: false, reason: "hold_clear" };
    expect(controlStateChanged(from, to)).toBe(true);
  });

  it("reports no change for two structurally identical states", () => {
    const from = { ready: true, held: false, reason: "hold_clear" };
    const to = { ready: true, held: false, reason: "hold_clear" };
    expect(controlStateChanged(from, to)).toBe(false);
  });
});
