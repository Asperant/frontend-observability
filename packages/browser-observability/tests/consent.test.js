import { beforeEach, describe, expect, it } from "vitest";

import { getObservabilityStatus, setTrackingConsent } from "../src/index.js";
import { resetState } from "../src/internal/state.js";

beforeEach(() => {
  resetState();
});

describe("setTrackingConsent", () => {
  it.each(["granted", "denied", "unknown"])("accepts the valid value %s", (consent) => {
    const result = setTrackingConsent(consent);
    expect(result.ok).toBe(true);
    expect(getObservabilityStatus().consent).toBe(consent);
  });

  it.each([null, undefined, "yes", 1, {}])("rejects an invalid value %p", (consent) => {
    const before = getObservabilityStatus().consent;
    const result = setTrackingConsent(consent);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_consent_value");
    expect(getObservabilityStatus().consent).toBe(before);
  });
});
