import { describe, expect, it } from "vitest";

import { mapConsent } from "../../src/adapter/openobserve/map-consent.js";

describe("mapConsent", () => {
  it("maps granted to the SDK's granted literal", () => {
    expect(mapConsent("granted")).toBe("granted");
  });

  it.each(["not-granted", "unknown", "denied", null, undefined, 42, {}])(
    "fails closed to not-granted for anything else: %p",
    (value) => {
      expect(mapConsent(value)).toBe("not-granted");
    },
  );
});
