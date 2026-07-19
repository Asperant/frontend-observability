import { describe, expect, it } from "vitest";

import { applyFetchOutcome } from "../../src/runtime-control/apply-document.js";
import { isCollectionGateOpen } from "../../src/runtime-control/gate.js";
import {
  ensureControlRegistry,
  resetControlRegistryForTests,
} from "../../src/runtime-control/registry.js";
import { snapshotRuntimeControl } from "../../src/runtime-control/status.js";

const NOW = new Date("2026-07-19T19:02:00.000Z");

function doc(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    issuedAt: "2026-07-19T19:00:00.000Z",
    expiresAt: "2026-07-19T19:05:00.000Z",
    killSwitch: { active: false, reasonCode: "none" },
    ...overrides,
  };
}

describe("isCollectionGateOpen", () => {
  it("is closed before any control document has ever been applied", () => {
    resetControlRegistryForTests();
    expect(isCollectionGateOpen(NOW)).toBe(false);
  });

  it("opens once a live, non-latched document has been applied", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc() }, NOW);
    expect(isCollectionGateOpen(NOW)).toBe(true);
  });

  it("closes once the applied document's expiresAt lapses, even without a new fetch", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc() }, NOW);
    expect(isCollectionGateOpen(new Date("2026-07-19T19:06:00.000Z"))).toBe(false);
  });

  it("closes permanently once the kill switch latches, regardless of later documents", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 1 }) }, NOW);
    applyFetchOutcome(
      registry,
      {
        ok: true,
        document: doc({
          revision: 2,
          killSwitch: { active: true, reasonCode: "operator_request" },
        }),
      },
      NOW,
    );
    expect(isCollectionGateOpen(NOW)).toBe(false);
    applyFetchOutcome(
      registry,
      {
        ok: true,
        document: doc({ revision: 3, killSwitch: { active: false, reasonCode: "none" } }),
      },
      NOW,
    );
    expect(isCollectionGateOpen(NOW)).toBe(false);
  });
});

describe("snapshotRuntimeControl", () => {
  it("is frozen and holds only the documented, secret-free fields", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 7 }) }, NOW);
    const snapshot = snapshotRuntimeControl(NOW);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.killSwitch)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "state",
        "revision",
        "expiresAt",
        "lastCheckedAt",
        "lastAppliedAt",
        "consecutiveFailures",
        "killSwitch",
        "counters",
      ].sort(),
    );
    expect(Object.keys(snapshot.killSwitch).sort()).toEqual(
      ["active", "latched", "reasonCode"].sort(),
    );
    expect(Object.keys(snapshot.counters).sort()).toEqual(
      [
        "refreshSucceeded",
        "refreshFailed",
        "invalidRejected",
        "rollbackRejected",
        "expiredFailClosed",
        "killSwitchActivated",
      ].sort(),
    );
    expect(snapshot.revision).toBe(7);

    // Never the raw document body, endpoint, tokens, or free text.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("issuedAt");
    expect(serialized).not.toContain("schemaVersion");
    expect(serialized).not.toMatch(/observability\/control\.json/);
  });

  it("reports null revision/expiresAt before any document has ever been applied", () => {
    resetControlRegistryForTests();
    const snapshot = snapshotRuntimeControl(NOW);
    expect(snapshot.revision).toBeNull();
    expect(snapshot.expiresAt).toBeNull();
  });
});
