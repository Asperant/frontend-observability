import { applyFetchOutcome } from "./apply-document.js";
import {
  BACKOFF_LADDER_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
} from "./constants.js";
import { fetchControlDocument } from "./fetch-document.js";
import { applyJitter } from "./jitter.js";
import { ensureControlRegistry } from "./registry.js";
import { isBrowserRuntime } from "../internal/environment.js";

/**
 * Runs exactly one fetch+validate+apply cycle, single-flighted: a second
 * concurrent caller (e.g. an `online` event firing while the periodic timer
 * is already mid-fetch) is handed the same in-flight promise rather than
 * starting an overlapping request.
 */
export function runRefreshCycle({ signal } = {}) {
  const registry = ensureControlRegistry();
  if (registry.inFlightPromise) return registry.inFlightPromise;

  registry.currentlyRefreshing = true;
  registry.refreshAttemptCount += 1;
  const controller = new AbortController();
  registry.inFlightAbortController = controller;
  const abortOnParent = () => controller.abort();
  signal?.addEventListener("abort", abortOnParent, { once: true });

  const promise = (async () => {
    const result = await fetchControlDocument({ signal: controller.signal });
    return applyFetchOutcome(registry, result, new Date());
  })().finally(() => {
    signal?.removeEventListener("abort", abortOnParent);
    registry.currentlyRefreshing = false;
    registry.inFlightPromise = null;
    registry.inFlightAbortController = null;
  });

  registry.inFlightPromise = promise;
  return promise;
}

/**
 * Used once, by the bootstrap coordinator, before the runtime is ever
 * allowed to reach ACTIVE: `ok` reflects whether a valid control document is
 * now on file (either freshly fetched, or already present from before this
 * call — e.g. a shutdown()+reinitialize() cycle on the same page, where the
 * page-lifetime registry was never cleared). It is never true before the
 * very first successful fetch of this page's lifetime.
 */
export async function performInitialControlFetch({ signal } = {}) {
  const registry = ensureControlRegistry();
  if (!registry.hasAppliedOnce) {
    await runRefreshCycle({ signal });
  }
  return {
    ok: registry.hasAppliedOnce,
    reasonCode: registry.hasAppliedOnce ? "NONE" : "RUNTIME_CONTROL_UNAVAILABLE",
  };
}

function nextDelayMs(registry, outcome) {
  if (!outcome?.shouldBackoff) {
    return clamp(applyJitter(REFRESH_INTERVAL_MS, registry.refreshAttemptCount));
  }
  const rungIndex = Math.min(
    Math.max(0, registry.consecutiveFailures - 1),
    BACKOFF_LADDER_MS.length - 1,
  );
  return clamp(applyJitter(BACKOFF_LADDER_MS[rungIndex], registry.refreshAttemptCount));
}

function clamp(value) {
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, value));
}

function clearRegistryTimer(registry) {
  if (registry.timerHandle !== null) {
    globalThis.clearTimeout(registry.timerHandle);
    registry.timerHandle = null;
  }
}

function scheduleNext(registry, delayMs) {
  clearRegistryTimer(registry);
  registry.timerHandle = globalThis.setTimeout(() => {
    void tick();
  }, delayMs);
}

async function tick() {
  const registry = ensureControlRegistry();
  registry.timerHandle = null;
  if (!registry.loopStarted) return;
  const outcome = await runRefreshCycle();
  if (!registry.loopStarted) return;
  scheduleNext(registry, nextDelayMs(registry, outcome));
}

async function triggerImmediateRefresh() {
  const registry = ensureControlRegistry();
  if (!registry.loopStarted) return;
  clearRegistryTimer(registry);
  if (registry.inFlightPromise) return;
  const outcome = await runRefreshCycle();
  if (!registry.loopStarted) return;
  scheduleNext(registry, nextDelayMs(registry, outcome));
}

function installListeners(registry) {
  if (registry.listenersInstalled || !isBrowserRuntime()) return;
  const visibilityHandler = () => {
    if (globalThis.document?.visibilityState === "visible") void triggerImmediateRefresh();
  };
  const onlineHandler = () => void triggerImmediateRefresh();
  globalThis.document.addEventListener("visibilitychange", visibilityHandler);
  globalThis.window.addEventListener("online", onlineHandler);
  registry.visibilityHandler = visibilityHandler;
  registry.onlineHandler = onlineHandler;
  registry.listenersInstalled = true;
}

function removeListeners(registry) {
  if (!registry.listenersInstalled) return;
  globalThis.document?.removeEventListener("visibilitychange", registry.visibilityHandler);
  globalThis.window?.removeEventListener("online", registry.onlineHandler);
  registry.visibilityHandler = null;
  registry.onlineHandler = null;
  registry.listenersInstalled = false;
}

/**
 * Idempotent: a duplicate initializeObservability() call (same fingerprint,
 * or a shutdown()+reinitialize() cycle that lands back here) must never
 * result in a second timer or a second pair of listeners.
 */
export function startRuntimeControlLoop() {
  const registry = ensureControlRegistry();
  if (registry.loopStarted) return;
  registry.loopStarted = true;
  installListeners(registry);
  scheduleNext(
    registry,
    nextDelayMs(registry, { shouldBackoff: registry.consecutiveFailures > 0 }),
  );
}

export function stopRuntimeControlLoop() {
  const registry = ensureControlRegistry();
  registry.loopStarted = false;
  clearRegistryTimer(registry);
  registry.inFlightAbortController?.abort();
  removeListeners(registry);
}
