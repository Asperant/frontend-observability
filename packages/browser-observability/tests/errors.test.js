import { beforeEach, describe, expect, it } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  recordError,
  setTrackingConsent,
} from "../src/index.js";
import { resetState } from "../src/internal/state.js";
import { sanitizeError } from "../src/sanitization/sanitize-error.js";

beforeEach(() => {
  resetState();
});

describe("recordError lifecycle", () => {
  it("is a no-op before initialization", () => {
    const result = recordError(new Error("boom"));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_ready");
  });

  it("is a no-op without granted consent", () => {
    initializeObservability({ applicationId: "demo" });
    const result = recordError(new Error("boom"));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("consent_not_granted");
  });

  it("records an Error instance once ready and consented", () => {
    initializeObservability({ applicationId: "demo" });
    setTrackingConsent("granted");
    const before = getObservabilityStatus().diagnosticsCount;
    const result = recordError(new Error("boom"), { screen: "checkout" });
    expect(result.ok).toBe(true);
    expect(getObservabilityStatus().diagnosticsCount).toBe(before + 1);
  });

  it("never throws for a non-Error value", () => {
    initializeObservability({ applicationId: "demo" });
    setTrackingConsent("granted");
    expect(() => recordError("plain string error")).not.toThrow();
    expect(() => recordError(null)).not.toThrow();
    expect(() => recordError(undefined)).not.toThrow();
    expect(() => recordError({ weird: "shape" })).not.toThrow();
  });
});

describe("sanitizeError", () => {
  it("extracts name/message/stack from a real Error", () => {
    const error = new Error("boom");
    const sanitized = sanitizeError(error);
    expect(sanitized.name).toBe("Error");
    expect(sanitized.message).toBe("boom");
    expect(sanitized.stack).toEqual(expect.any(String));
  });

  it("truncates oversized message and stack", () => {
    const error = new Error("x".repeat(1000));
    Object.defineProperty(error, "stack", { value: "y".repeat(4000) });
    const sanitized = sanitizeError(error);
    expect(sanitized.message.length).toBeLessThanOrEqual(512);
    expect(sanitized.stack.length).toBeLessThanOrEqual(2048);
  });

  it("falls back to safe defaults for non-string name/message/stack", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "name", { value: 42 });
    Object.defineProperty(error, "message", { value: 42 });
    Object.defineProperty(error, "stack", { value: 42 });
    const sanitized = sanitizeError(error);
    expect(sanitized.name).toBe("Error");
    expect(sanitized.message).toBe("");
    expect(sanitized.stack).toBeUndefined();
  });

  it("wraps a plain string error", () => {
    const sanitized = sanitizeError("plain message");
    expect(sanitized).toEqual({ name: "Error", message: "plain message" });
  });

  it.each([null, undefined, 42, {}, []])(
    "falls back for a non-Error, non-string value: %p",
    (value) => {
      const sanitized = sanitizeError(value);
      expect(sanitized.name).toBe("UnknownError");
    },
  );
});
