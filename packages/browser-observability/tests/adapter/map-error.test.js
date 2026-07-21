import { describe, expect, it } from "vitest";

import { mapError } from "../../src/adapter/openobserve/map-error.js";
import { sanitizeError } from "../../src/sanitization/sanitizers/error.js";

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

  it("preserves the real name/message through the real recordError() pipeline (record-error.js sanitizes once, then hands the plain {name,message,stack} result to the adapter's mapError, which must not re-collapse it to UnknownError)", () => {
    const firstPass = sanitizeError(new Error("Demo recorded error"));
    expect(firstPass.decision).not.toBe("drop");

    const result = mapError(firstPass.value.error, {});

    expect(result.error.name).toBe("Error");
    expect(result.error.message).toBe("Demo recorded error");
  });

  it("preserves a non-generic error name through the same two-pass pipeline", () => {
    class CustomError extends Error {
      constructor(message) {
        super(message);
        this.name = "ReferenceError";
      }
    }
    const firstPass = sanitizeError(new CustomError("x is not defined"));

    const result = mapError(firstPass.value.error, {});

    expect(result.error.name).toBe("ReferenceError");
    expect(result.error.message).toBe("x is not defined");
  });
});
