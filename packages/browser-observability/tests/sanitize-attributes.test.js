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
});
