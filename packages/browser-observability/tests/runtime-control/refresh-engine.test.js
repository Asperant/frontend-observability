import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  performInitialControlFetch,
  runRefreshCycle,
  startRuntimeControlLoop,
  stopRuntimeControlLoop,
} from "../../src/runtime-control/refresh-engine.js";
import {
  ensureControlRegistry,
  resetControlRegistryForTests,
} from "../../src/runtime-control/registry.js";

function validDocResponse(overrides = {}) {
  const now = new Date();
  const body = JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    killSwitch: { active: false, reasonCode: "none" },
    ...overrides,
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function failingResponse() {
  return new Response("{}", { status: 503 });
}

// Waits out a real macrotask so an event-triggered, fire-and-forget async
// chain (fetch -> body read -> JSON parse -> apply) has room to finish, in
// tests that don't use fake timers.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  resetControlRegistryForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  stopRuntimeControlLoop();
  vi.useRealTimers();
});

describe("runRefreshCycle single-flight", () => {
  it("shares one in-flight fetch across concurrent callers", async () => {
    let resolveFetch;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = runRefreshCycle();
    const second = runRefreshCycle();
    expect(first).toBe(second);

    resolveFetch(validDocResponse());
    await first;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("allows a new fetch once the previous cycle has resolved", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse({ revision: 1 })));
    await runRefreshCycle();
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse({ revision: 2 })));
    await runRefreshCycle();
    expect(ensureControlRegistry().currentDocument.revision).toBe(2);
  });
});

describe("performInitialControlFetch", () => {
  it("fetches once and reports ok:true on a valid first document", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    const result = await performInitialControlFetch();
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("reports ok:false when the very first fetch fails", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(failingResponse()));
    const result = await performInitialControlFetch();
    expect(result.ok).toBe(false);
    expect(ensureControlRegistry().hasAppliedOnce).toBe(false);
  });

  it("skips fetching again once a document is already on file (reinitialize on the same page)", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const second = await performInitialControlFetch();
    expect(second.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("startRuntimeControlLoop / stopRuntimeControlLoop", () => {
  it("is idempotent: a duplicate start does not create a second timer", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    startRuntimeControlLoop();
    startRuntimeControlLoop();

    await vi.advanceTimersByTimeAsync(33_000);
    // One initial fetch (performInitialControlFetch) + exactly one periodic
    // tick, never two, even though start was called twice.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("schedules the next refresh within the bounded normal interval after success", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    startRuntimeControlLoop();

    await vi.advanceTimersByTimeAsync(26_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // too early
    await vi.advanceTimersByTimeAsync(8_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // within [27s, 33s] window
  });

  it("backs off along the fixed ladder on consecutive failures", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    globalThis.fetch = vi.fn(() => Promise.resolve(failingResponse()));
    startRuntimeControlLoop();

    // The loop's *first* tick after start was already scheduled at the
    // normal ~30s interval, based on the prior successful initial fetch —
    // it is this first tick, once it fires and fails, that puts the loop on
    // the backoff ladder for the ticks after it.
    await vi.advanceTimersByTimeAsync(33_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(ensureControlRegistry().consecutiveFailures).toBe(1);

    await vi.advanceTimersByTimeAsync(16_000); // ~15s rung
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(31_000); // ~30s rung
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(61_000); // ~60s rung
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("resets to the normal interval once a refresh succeeds again after failures", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    globalThis.fetch = vi.fn(() => Promise.resolve(failingResponse()));
    startRuntimeControlLoop();
    await vi.advanceTimersByTimeAsync(33_000); // first tick (normal interval) fires and fails
    expect(ensureControlRegistry().consecutiveFailures).toBe(1);

    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse({ revision: 2 })));
    await vi.advanceTimersByTimeAsync(16_000); // next tick: first backoff rung (~15s) fires and succeeds
    expect(ensureControlRegistry().consecutiveFailures).toBe(0);
    expect(ensureControlRegistry().currentDocument.revision).toBe(2);
  });

  it("stop clears the timer: no further fetches happen afterward", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    startRuntimeControlLoop();
    stopRuntimeControlLoop();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // only the initial fetch
  });

  it("stop is idempotent and safe to call when never started", () => {
    expect(() => stopRuntimeControlLoop()).not.toThrow();
    expect(() => stopRuntimeControlLoop()).not.toThrow();
  });

  it("visibilitychange (becoming visible) triggers an immediate refresh", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    startRuntimeControlLoop();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse({ revision: 2 })));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(ensureControlRegistry().currentDocument.revision).toBe(2);
  });

  it("the online event triggers an immediate refresh", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    startRuntimeControlLoop();

    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse({ revision: 3 })));
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(ensureControlRegistry().currentDocument.revision).toBe(3);
  });

  it("listeners are removed after stop: further visibility/online events do nothing", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    startRuntimeControlLoop();
    stopRuntimeControlLoop();

    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse({ revision: 9 })));
    window.dispatchEvent(new Event("online"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("duplicate start after a stop+restart cycle still runs only one loop", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => Promise.resolve(validDocResponse()));
    await performInitialControlFetch();
    startRuntimeControlLoop();
    stopRuntimeControlLoop();
    startRuntimeControlLoop();
    startRuntimeControlLoop();

    await vi.advanceTimersByTimeAsync(33_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // initial fetch + exactly one periodic tick
  });
});
