import { describe, expect, it } from "vitest";

import { PRIVACY_BASELINE, isPrivacyBaselineIntact } from "../src/privacy/privacy-baseline.js";

describe("isPrivacyBaselineIntact", () => {
  it("treats null as intact (nothing to weaken)", () => {
    expect(isPrivacyBaselineIntact(null)).toBe(true);
  });

  it("treats non-object candidates as intact", () => {
    expect(isPrivacyBaselineIntact("not-an-object")).toBe(true);
    expect(isPrivacyBaselineIntact(42)).toBe(true);
  });

  it("treats an empty object as intact (defaults apply)", () => {
    expect(isPrivacyBaselineIntact({})).toBe(true);
  });

  it("treats explicit safe values as intact", () => {
    expect(isPrivacyBaselineIntact({ ...PRIVACY_BASELINE })).toBe(true);
  });

  it.each(Object.keys(PRIVACY_BASELINE))("flags %s flipped to an unsafe value", (key) => {
    expect(isPrivacyBaselineIntact({ [key]: true })).toBe(false);
  });
});
