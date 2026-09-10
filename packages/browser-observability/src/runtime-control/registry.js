// Page-lifetime singleton, deliberately separate from
// bootstrap/runtime-registry.js's per-activation runtime state: the control
// document, its revision, and — most importantly — the kill-switch latch
// must all survive a shutdownObservability() + re-initialize() cycle on the
// same page (see docs/runtime-control-and-kill-switch.md). Only a real page
// reload (a fresh globalThis) may ever clear this registry; the
// resetControlRegistryForTests() escape hatch below exists purely for test
// isolation and must never be called from production code paths.
const CONTROL_SYMBOL = Symbol.for("@frontend-observability/browser-observability/runtime-control");

function createInitialRegistry() {
  return {
    currentDocument: null,
    state: null,
    lastCheckedAt: null,
    lastAppliedAt: null,
    consecutiveFailures: 0,
    hasAppliedOnce: false,

    killSwitchActive: false,
    killSwitchLatched: false,
    killSwitchReasonCode: "none",

    gateOpen: false,

    counters: {
      refreshSucceeded: 0,
      refreshFailed: 0,
      invalidRejected: 0,
      rollbackRejected: 0,
      expiredFailClosed: 0,
      killSwitchActivated: 0,
    },

    // Runtime-only scheduling/coordination state, never read by status.js.
    timerHandle: null,
    inFlightPromise: null,
    inFlightAbortController: null,
    currentlyRefreshing: false,
    listenersInstalled: false,
    loopStarted: false,
    refreshAttemptCount: 0,
    visibilityHandler: null,
    onlineHandler: null,
    lastOutcomeState: null,
  };
}

export function ensureControlRegistry() {
  if (!globalThis[CONTROL_SYMBOL]) {
    Object.defineProperty(globalThis, CONTROL_SYMBOL, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: createInitialRegistry(),
    });
  }
  return globalThis[CONTROL_SYMBOL];
}

export function incrementControlCounter(key) {
  const registry = ensureControlRegistry();
  if (!(key in registry.counters)) return;
  registry.counters[key] += 1;
}

export function resetControlRegistryForTests() {
  Object.defineProperty(globalThis, CONTROL_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: createInitialRegistry(),
  });
}
