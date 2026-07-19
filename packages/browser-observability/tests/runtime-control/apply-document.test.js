import { describe, expect, it } from "vitest";

import {
  applyFetchOutcome,
  computeRuntimeControlState,
} from "../../src/runtime-control/apply-document.js";
import { RuntimeControlStates } from "../../src/runtime-control/constants.js";
import {
  ensureControlRegistry,
  resetControlRegistryForTests,
} from "../../src/runtime-control/registry.js";
import { ControlReasonCodes } from "../../src/runtime-control/validate-document.js";
import { ControlTransportReasonCodes } from "../../src/runtime-control/fetch-document.js";

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

describe("applyFetchOutcome / computeRuntimeControlState", () => {
  it("applies the first document ever seen (revision > -1 sentinel)", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    const outcome = applyFetchOutcome(registry, { ok: true, document: doc({ revision: 0 }) }, NOW);
    expect(outcome.shouldBackoff).toBe(false);
    expect(registry.hasAppliedOnce).toBe(true);
    expect(registry.currentDocument.revision).toBe(0);
    expect(registry.counters.refreshSucceeded).toBe(1);
    expect(computeRuntimeControlState(registry, NOW)).toBe(RuntimeControlStates.FRESH);
  });

  it("applies a strictly newer revision and advances lastAppliedAt", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 1 }) }, NOW);
    const outcome = applyFetchOutcome(
      registry,
      { ok: true, document: doc({ revision: 2 }) },
      new Date(NOW.getTime() + 1000),
    );
    expect(outcome.shouldBackoff).toBe(false);
    expect(registry.currentDocument.revision).toBe(2);
  });

  it("treats an equal revision as a no-op heartbeat, not a rollback", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 5 }) }, NOW);
    const lastApplied = registry.lastAppliedAt;
    const outcome = applyFetchOutcome(registry, { ok: true, document: doc({ revision: 5 }) }, NOW);
    expect(outcome.shouldBackoff).toBe(false);
    expect(registry.currentDocument.revision).toBe(5);
    expect(registry.lastAppliedAt).toBe(lastApplied);
    expect(registry.counters.rollbackRejected).toBe(0);
  });

  it("rejects a lower revision as rollback and keeps the last-known-good document", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 5 }) }, NOW);
    const outcome = applyFetchOutcome(registry, { ok: true, document: doc({ revision: 4 }) }, NOW);
    expect(outcome.shouldBackoff).toBe(true);
    expect(registry.currentDocument.revision).toBe(5);
    expect(registry.counters.rollbackRejected).toBe(1);
    expect(computeRuntimeControlState(registry, NOW)).toBe(RuntimeControlStates.ROLLBACK_REJECTED);
  });

  it("marks a document-shape failure as invalidRejected and keeps serving the cached document", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 1 }) }, NOW);
    const outcome = applyFetchOutcome(
      registry,
      { ok: false, reasonCode: ControlReasonCodes.UNKNOWN_KEY },
      NOW,
    );
    expect(outcome.shouldBackoff).toBe(true);
    expect(registry.counters.invalidRejected).toBe(1);
    expect(registry.counters.refreshFailed).toBe(0);
    expect(computeRuntimeControlState(registry, NOW)).toBe(RuntimeControlStates.INVALID);
    // The cache is still live, so the gate-relevant document is unaffected.
    expect(registry.currentDocument.revision).toBe(1);
  });

  it("marks a transport failure as degraded while the cached document is still live", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 1 }) }, NOW);
    const outcome = applyFetchOutcome(
      registry,
      { ok: false, reasonCode: ControlTransportReasonCodes.UNAVAILABLE },
      NOW,
    );
    expect(outcome.shouldBackoff).toBe(true);
    expect(registry.counters.refreshFailed).toBe(1);
    expect(registry.counters.expiredFailClosed).toBe(0);
    expect(computeRuntimeControlState(registry, NOW)).toBe(RuntimeControlStates.DEGRADED);
  });

  it("fails closed to expired when a transport failure happens with no live cache", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    const outcome = applyFetchOutcome(
      registry,
      { ok: false, reasonCode: ControlTransportReasonCodes.TIMEOUT },
      NOW,
    );
    expect(outcome.shouldBackoff).toBe(true);
    expect(registry.counters.expiredFailClosed).toBe(1);
    expect(computeRuntimeControlState(registry, NOW)).toBe(RuntimeControlStates.EXPIRED);
  });

  it("fails closed to expired once the cached document's own expiresAt lapses", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 1 }) }, NOW);
    const later = new Date("2026-07-19T19:06:00.000Z"); // past the doc's expiresAt
    expect(computeRuntimeControlState(registry, later)).toBe(RuntimeControlStates.EXPIRED);
  });

  it("latches the kill switch on activation and keeps it latched despite a later active:false document", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(registry, { ok: true, document: doc({ revision: 1 }) }, NOW);
    const activation = applyFetchOutcome(
      registry,
      {
        ok: true,
        document: doc({
          revision: 2,
          killSwitch: { active: true, reasonCode: "security_incident" },
        }),
      },
      NOW,
    );
    expect(activation.shouldBackoff).toBe(false);
    expect(registry.killSwitchLatched).toBe(true);
    expect(registry.killSwitchActive).toBe(true);
    expect(registry.counters.killSwitchActivated).toBe(1);
    expect(computeRuntimeControlState(registry, NOW)).toBe(RuntimeControlStates.KILL_SWITCHED);

    // A later, otherwise-valid, higher-revision document says active:false —
    // the latch must not clear within this page's lifetime.
    applyFetchOutcome(
      registry,
      {
        ok: true,
        document: doc({ revision: 3, killSwitch: { active: false, reasonCode: "none" } }),
      },
      NOW,
    );
    expect(registry.killSwitchLatched).toBe(true);
    expect(computeRuntimeControlState(registry, NOW)).toBe(RuntimeControlStates.KILL_SWITCHED);
  });

  it("only latches once (a second active:true document does not double-count the counter)", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(
      registry,
      {
        ok: true,
        document: doc({ revision: 1, killSwitch: { active: true, reasonCode: "maintenance" } }),
      },
      NOW,
    );
    applyFetchOutcome(
      registry,
      {
        ok: true,
        document: doc({ revision: 2, killSwitch: { active: true, reasonCode: "maintenance" } }),
      },
      NOW,
    );
    expect(registry.counters.killSwitchActivated).toBe(1);
  });

  it("priority: a latch always reports kill-switched even once the document expires", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    applyFetchOutcome(
      registry,
      {
        ok: true,
        document: doc({
          revision: 1,
          killSwitch: { active: true, reasonCode: "operator_request" },
        }),
      },
      NOW,
    );
    const farFuture = new Date("2099-01-01T00:00:00.000Z");
    expect(computeRuntimeControlState(registry, farFuture)).toBe(
      RuntimeControlStates.KILL_SWITCHED,
    );
  });
});
