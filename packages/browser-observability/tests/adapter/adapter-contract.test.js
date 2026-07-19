import { describe, expect, it, vi } from "vitest";

import { initializeAdapter, isValidAdapter } from "../../src/adapter/adapter-contract.js";

function fakeAdapter(overrides = {}) {
  return {
    name: "fake",
    initialize: vi.fn(),
    setTrackingConsent: vi.fn(),
    recordAction: vi.fn(),
    recordError: vi.fn(),
    startSessionReplay: vi.fn(),
    stopSessionReplay: vi.fn(),
    shutdown: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
    ...overrides,
  };
}

describe("isValidAdapter", () => {
  it("accepts an object implementing all 8 contract methods with a name", () => {
    expect(isValidAdapter(fakeAdapter())).toBe(true);
  });

  it.each([null, undefined, 42, "adapter", [], {}])("rejects non-adapter value: %p", (value) => {
    expect(isValidAdapter(value)).toBe(false);
  });

  it("rejects an object missing a required method", () => {
    const adapter = fakeAdapter();
    delete adapter.shutdown;
    expect(isValidAdapter(adapter)).toBe(false);
  });

  it("rejects an object with an empty name", () => {
    expect(isValidAdapter(fakeAdapter({ name: "" }))).toBe(false);
  });
});

describe("initializeAdapter", () => {
  it("returns ok:false without calling anything when the factory isn't a function", async () => {
    const result = await initializeAdapter(null, {});
    expect(result).toEqual({ ok: false, adapter: null });
  });

  it("returns ok:false when the factory produces an invalid adapter", async () => {
    const result = await initializeAdapter(() => ({}), {});
    expect(result).toEqual({ ok: false, adapter: null });
  });

  it("calls adapter.initialize(context) and returns ok:true on success", async () => {
    const adapter = fakeAdapter();
    const context = { service: "x" };
    const result = await initializeAdapter(() => adapter, context);
    expect(adapter.initialize).toHaveBeenCalledWith(context);
    expect(result).toEqual({ ok: true, adapter });
  });

  it("surfaces a recognized reasonCode from a thrown error without the error itself", async () => {
    const error = new Error("openobserve init failed with secret ABC");
    error.reasonCode = "ADAPTER_INITIALIZATION_FAILED";
    const adapter = fakeAdapter({
      initialize: vi.fn().mockRejectedValue(error),
    });

    const result = await initializeAdapter(() => adapter, {});
    expect(result).toEqual({
      ok: false,
      adapter: null,
      thrown: true,
      reasonCode: "ADAPTER_INITIALIZATION_FAILED",
    });
  });

  it("falls back to a generic thrown:true (no reasonCode) for an unrecognized/absent reasonCode", async () => {
    const adapter = fakeAdapter({
      initialize: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await initializeAdapter(() => adapter, {});
    expect(result.ok).toBe(false);
    expect(result.thrown).toBe(true);
    expect(result.reasonCode).toBeUndefined();
  });

  it("ignores a reasonCode value that is not a real ReasonCodes member", async () => {
    const error = new Error("boom");
    error.reasonCode = "TOTALLY_MADE_UP";
    const adapter = fakeAdapter({ initialize: vi.fn().mockRejectedValue(error) });

    const result = await initializeAdapter(() => adapter, {});
    expect(result.reasonCode).toBeUndefined();
  });
});
