import { describe, expect, it } from "vitest";

import { sanitizeAttributes } from "../src/sanitization/sanitize-attributes.js";

describe("sanitizeAttributes", () => {
  it.each([undefined, null])("returns {} for %p", (value) => {
    expect(sanitizeAttributes(value)).toEqual({});
  });

  it.each(["string", 42, ["array"]])("returns {} for non-plain-object %p", (value) => {
    expect(sanitizeAttributes(value)).toEqual({});
  });

  it("keeps string, number, and boolean values", () => {
    const result = sanitizeAttributes({ a: "s", b: 1, c: true });
    expect(result).toEqual({ a: "s", b: 1, c: true });
  });

  it("redacts oversized token-like string values", () => {
    const result = sanitizeAttributes({ a: "x".repeat(1000) });
    expect(result.a).toBe("[REDACTED_TOKEN]");
  });

  it("drops NaN/Infinity numeric values", () => {
    const result = sanitizeAttributes({ a: Number.NaN, b: Infinity, c: 5 });
    expect(result).toEqual({ c: 5 });
  });

  it("drops object, array, and function values", () => {
    const result = sanitizeAttributes({ a: { nested: true }, b: [1, 2], c: () => {} });
    expect(result).toEqual({});
  });

  it("drops keys that do not match the allowed key pattern", () => {
    const result = sanitizeAttributes({ "bad key": 1, "1bad": 2, ok_key: 3 });
    expect(result).toEqual({ "1bad": 2, ok_key: 3 });
  });

  it("drops keys longer than the max key length", () => {
    const longKey = "a".repeat(100);
    const result = sanitizeAttributes({ [longKey]: 1 });
    expect(result).toEqual({});
  });

  it("caps the number of attributes at 12", () => {
    const input = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const result = sanitizeAttributes(input);
    expect(Object.keys(result)).toHaveLength(12);
  });

  it("rejects an own __proto__ key instead of letting it change the result's prototype", () => {
    const attacker = JSON.parse('{"__proto__": null, "safe": "ok"}');
    const result = sanitizeAttributes(attacker);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ safe: "ok" });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "drops the reserved key %p instead of storing it",
    (key) => {
      const attacker = JSON.parse(`{"${key}": "x", "safe": "ok"}`);
      const result = sanitizeAttributes(attacker);
      expect(result).toEqual({ safe: "ok" });
    },
  );

  it("does not reject a legitimate key that merely contains 'proto' as a substring", () => {
    const result = sanitizeAttributes({ protocol: "https" });
    expect(result).toEqual({ protocol: "https" });
  });

  it("bounds regex-based PII/secret scanning for values far longer than the scan limit", () => {
    const huge = "x".repeat(200_000);
    const start = Date.now();
    const result = sanitizeAttributes({ big: huge });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.big).not.toBe(huge);
  });
});
