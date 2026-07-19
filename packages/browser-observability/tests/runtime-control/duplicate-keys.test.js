import { describe, expect, it } from "vitest";

import { hasDuplicateObjectKeys } from "../../src/runtime-control/duplicate-keys.js";

describe("hasDuplicateObjectKeys", () => {
  it("returns false for a document with no duplicate keys", () => {
    expect(
      hasDuplicateObjectKeys(
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          issuedAt: "2026-07-19T00:00:00.000Z",
          expiresAt: "2026-07-19T00:05:00.000Z",
          killSwitch: { active: false, reasonCode: "none" },
        }),
      ),
    ).toBe(false);
  });

  it("detects a duplicate key at the top level", () => {
    expect(hasDuplicateObjectKeys('{"revision":1,"revision":2}')).toBe(true);
  });

  it("detects a duplicate key nested inside killSwitch", () => {
    expect(hasDuplicateObjectKeys('{"killSwitch":{"active":false,"active":true}}')).toBe(true);
  });

  it("ignores keys that merely look similar inside string values", () => {
    expect(hasDuplicateObjectKeys('{"a":"revision revision","b":1}')).toBe(false);
  });

  it("handles escaped quotes inside string keys/values without false positives", () => {
    expect(hasDuplicateObjectKeys('{"a":"a value with \\"quotes\\"","b":2}')).toBe(false);
  });

  it("detects duplicates inside array elements", () => {
    expect(hasDuplicateObjectKeys('{"list":[{"x":1,"x":2}]}')).toBe(true);
  });

  it("does not flag the same key name used at two different nesting levels", () => {
    expect(hasDuplicateObjectKeys('{"active":true,"killSwitch":{"active":false}}')).toBe(false);
  });

  it("fails safe (returns false) on malformed input, deferring to JSON.parse", () => {
    expect(hasDuplicateObjectKeys("{not json")).toBe(false);
    expect(hasDuplicateObjectKeys("")).toBe(false);
    expect(hasDuplicateObjectKeys(null)).toBe(false);
    expect(hasDuplicateObjectKeys(undefined)).toBe(false);
  });
});
