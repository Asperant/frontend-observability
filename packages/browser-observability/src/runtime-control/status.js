import { computeRuntimeControlState } from "./apply-document.js";
import { ensureControlRegistry } from "./registry.js";

/**
 * Secrets-free summary only: never the raw control document body, endpoint
 * internal details, tokens, stack traces, or free-text incident notes —
 * just the closed set of fields the acceptance criteria require.
 */
export function snapshotRuntimeControl(now = new Date()) {
  const registry = ensureControlRegistry();
  return Object.freeze({
    state: computeRuntimeControlState(registry, now),
    revision: registry.currentDocument?.revision ?? null,
    expiresAt: registry.currentDocument?.expiresAt ?? null,
    lastCheckedAt: registry.lastCheckedAt,
    lastAppliedAt: registry.lastAppliedAt,
    consecutiveFailures: registry.consecutiveFailures,
    killSwitch: Object.freeze({
      active: registry.killSwitchActive,
      latched: registry.killSwitchLatched,
      reasonCode: registry.killSwitchReasonCode,
    }),
    counters: Object.freeze({ ...registry.counters }),
  });
}
