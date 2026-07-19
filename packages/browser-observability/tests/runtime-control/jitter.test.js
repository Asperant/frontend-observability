import { describe, expect, it } from "vitest";

import { applyJitter } from "../../src/runtime-control/jitter.js";

describe("applyJitter", () => {
  it("is deterministic for a given (baseIntervalMs, attemptCount) pair", () => {
    expect(applyJitter(30_000, 5)).toBe(applyJitter(30_000, 5));
    expect(applyJitter(15_000, 42)).toBe(applyJitter(15_000, 42));
  });

  it("stays within +/-10% of the base interval", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = applyJitter(30_000, attempt);
      expect(result).toBeGreaterThanOrEqual(27_000);
      expect(result).toBeLessThanOrEqual(33_000);
    }
  });

  it("does not vary output identically for every attempt (spreads across the range)", () => {
    const values = new Set(Array.from({ length: 10 }, (_, i) => applyJitter(30_000, i)));
    expect(values.size).toBeGreaterThan(1);
  });

  it("returns the base interval unchanged when the bound would be zero", () => {
    expect(applyJitter(0, 3)).toBe(0);
  });
});
