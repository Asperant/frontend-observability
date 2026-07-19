import { describe, expect, it } from "vitest";

import { mapError } from "../../src/adapter/openobserve/map-error.js";

describe("mapError", () => {
  it("forwards a sanitized Error copy so the SDK keeps a safe stack", () => {
    const error = new Error("boom");
    const result = mapError(error, { screen: "checkout" });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBe(error);
    expect(result.error.message).toBe("boom");
    expect(result.context).toEqual({ screen: "checkout" });
  });

  it("wraps a non-Error value in a real Error built from the sanitized message", () => {
    const result = mapError("plain string error", {});
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe("plain string error");
  });

  it.each([null, undefined, 42, {}, []])("never throws for unusual error value: %p", (value) => {
    expect(() => mapError(value, {})).not.toThrow();
    expect(mapError(value, {}).error).toBeInstanceOf(Error);
  });

  it("bounds/sanitizes the context the same way custom actions do", () => {
    const result = mapError(new Error("boom"), { valid: "x", nested: { a: 1 } });
    expect(result.context).toEqual({ valid: "x" });
  });

  it("defaults context to an empty object", () => {
    expect(mapError(new Error("boom"), undefined).context).toEqual({});
  });
});
