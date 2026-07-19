import { describe, expect, it } from "vitest";

import {
  ensureControlRegistry,
  incrementControlCounter,
  resetControlRegistryForTests,
} from "../../src/runtime-control/registry.js";

describe("runtime-control registry", () => {
  it("is a page-lifetime singleton: repeated calls return the same object", () => {
    resetControlRegistryForTests();
    const first = ensureControlRegistry();
    const second = ensureControlRegistry();
    expect(first).toBe(second);
  });

  it("starts with a closed gate and no applied document", () => {
    resetControlRegistryForTests();
    const registry = ensureControlRegistry();
    expect(registry.hasAppliedOnce).toBe(false);
    expect(registry.currentDocument).toBeNull();
    expect(registry.killSwitchLatched).toBe(false);
  });

  it("resetControlRegistryForTests() replaces the singleton with a fresh instance", () => {
    const before = ensureControlRegistry();
    before.currentDocument = { revision: 99 };
    resetControlRegistryForTests();
    const after = ensureControlRegistry();
    expect(after).not.toBe(before);
    expect(after.currentDocument).toBeNull();
  });

  it("incrementControlCounter only touches known counter keys", () => {
    resetControlRegistryForTests();
    incrementControlCounter("refreshSucceeded");
    incrementControlCounter("notARealCounter");
    const registry = ensureControlRegistry();
    expect(registry.counters.refreshSucceeded).toBe(1);
    expect(registry.counters.notARealCounter).toBeUndefined();
  });
});
