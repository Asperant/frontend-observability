import { beforeEach, describe, expect, it } from "vitest";

import { getObservabilityStatus, initializeObservability } from "../src/index.js";
import { validateOptions } from "../src/config/validate-options.js";
import { normalizeOptions } from "../src/config/normalize-options.js";
import { resetState } from "../src/internal/state.js";

beforeEach(() => {
  resetState();
});

describe("validateOptions", () => {
  it.each([null, undefined, "string", 42, ["array"]])(
    "rejects non-object options: %p",
    (options) => {
      const result = validateOptions(options);
      expect(result.valid).toBe(false);
    },
  );

  it("rejects a missing applicationId", () => {
    expect(validateOptions({}).valid).toBe(false);
  });

  it("rejects an empty applicationId", () => {
    expect(validateOptions({ applicationId: "   " }).valid).toBe(false);
  });

  it("rejects an oversized applicationId", () => {
    expect(validateOptions({ applicationId: "a".repeat(200) }).valid).toBe(false);
  });

  it("rejects an unknown privacyProfile", () => {
    const result = validateOptions({ applicationId: "demo", privacyProfile: "permissive" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes("privacyProfile"))).toBe(true);
  });

  it("accepts an undefined privacyProfile", () => {
    expect(validateOptions({ applicationId: "demo" }).valid).toBe(true);
  });

  it("rejects an attempt to weaken the privacy baseline", () => {
    const result = validateOptions({ applicationId: "demo", sessionReplayEnabled: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes("privacy baseline"))).toBe(true);
  });

  it("accepts fully valid options", () => {
    const result = validateOptions({ applicationId: "demo", privacyProfile: "balanced" });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("normalizeOptions", () => {
  it("fills in defaults and trims applicationId", () => {
    const normalized = normalizeOptions({ applicationId: "  demo  " });
    expect(normalized.applicationId).toBe("demo");
    expect(normalized.environment).toBe("production");
    expect(normalized.privacyProfile).toBe("strict");
    expect(normalized.sessionReplayEnabled).toBe(false);
  });

  it("preserves an explicit privacyProfile", () => {
    const normalized = normalizeOptions({ applicationId: "demo", privacyProfile: "balanced" });
    expect(normalized.privacyProfile).toBe("balanced");
  });
});

describe("validation failure isolation", () => {
  it("does not throw and leaves the package initializable after invalid options", () => {
    const badResult = initializeObservability({ applicationId: "" });
    expect(badResult.ok).toBe(false);
    expect(badResult.reason).toBe("invalid_options");
    expect(getObservabilityStatus().status).toBe("error");
    expect(getObservabilityStatus().lastError).toEqual(expect.any(String));

    const goodResult = initializeObservability({ applicationId: "demo" });
    expect(goodResult.ok).toBe(true);
    expect(getObservabilityStatus().status).toBe("ready");
  });

  it("rejects a privacy-baseline-weakening init without throwing", () => {
    expect(() =>
      initializeObservability({ applicationId: "demo", collectCookies: true }),
    ).not.toThrow();
    const result = initializeObservability({ applicationId: "demo", collectCookies: true });
    expect(result.ok).toBe(false);
  });
});
