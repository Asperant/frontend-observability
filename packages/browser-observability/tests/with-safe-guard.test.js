import { describe, expect, it, vi } from "vitest";

import { withSafeGuard } from "../src/internal/with-safe-guard.js";

vi.mock("../src/diagnostics/record-diagnostic.js", () => ({
  recordDiagnostic: vi.fn(() => {
    throw new Error("diagnostics unavailable");
  }),
}));

describe("withSafeGuard", () => {
  it("passes through a successful call", () => {
    const guarded = withSafeGuard(() => 42, "fallback");
    expect(guarded()).toBe(42);
  });

  it("passes through call arguments", () => {
    const guarded = withSafeGuard((a, b) => a + b, 0);
    expect(guarded(2, 3)).toBe(5);
  });

  it("returns a static fallback when the wrapped function throws", () => {
    const guarded = withSafeGuard(() => {
      throw new Error("boom");
    }, "fallback");
    expect(guarded()).toBe("fallback");
  });

  it("returns a computed fallback when the wrapped function throws", () => {
    const guarded = withSafeGuard(
      () => {
        throw new Error("boom");
      },
      (error) => `handled: ${error.message}`,
    );
    expect(guarded()).toBe("handled: boom");
  });

  it("never propagates even when recordDiagnostic itself throws", () => {
    const guarded = withSafeGuard(() => {
      throw new Error("boom");
    }, "fallback");
    expect(() => guarded()).not.toThrow();
    expect(guarded()).toBe("fallback");
  });
});
