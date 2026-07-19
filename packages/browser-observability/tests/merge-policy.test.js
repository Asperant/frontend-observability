import { describe, expect, it } from "vitest";

import { mergePrivacyPolicy, PLATFORM_PRIVACY_BASELINE } from "../src/config/merge-policy.js";

const identity = Object.freeze({
  service: "demo-frontend",
  environment: "production",
  version: "1.0.0",
});

function config(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    enabled: true,
    issuedAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    killSwitch: { engaged: false },
    privacyProfile: "strict",
    sampling: { sessionSampleRate: 1, errorSampleRate: 1 },
    rum: {
      site: "localhost:8443",
      organizationIdentifier: "default",
      applicationId: "app",
      clientToken: "a".repeat(48),
      apiVersion: "v1",
    },
    browserLogs: { enabled: true },
    sessionReplay: { enabled: false },
    allowedRoutes: ["/a", "/a", "/b"],
    allowedSelectors: ["#app"],
    ...overrides,
  };
}

describe("mergePrivacyPolicy", () => {
  it("forwards the rum connection block through unchanged", () => {
    const policy = mergePrivacyPolicy(identity, config());
    expect(policy.rum).toEqual({
      site: "localhost:8443",
      organizationIdentifier: "default",
      applicationId: "app",
      clientToken: "a".repeat(48),
      apiVersion: "v1",
    });
  });

  it("reflects a config-requested browserLogs.enabled when telemetry is enabled", () => {
    expect(
      mergePrivacyPolicy(identity, config({ browserLogs: { enabled: true } })).browserLogs,
    ).toEqual({
      enabled: true,
    });
    expect(
      mergePrivacyPolicy(identity, config({ browserLogs: { enabled: false } })).browserLogs,
    ).toEqual({
      enabled: false,
    });
  });

  it("forces browserLogs.enabled false when the kill switch is engaged, even if the config requests true", () => {
    const policy = mergePrivacyPolicy(
      identity,
      config({ killSwitch: { engaged: true }, browserLogs: { enabled: true } }),
    );
    expect(policy.browserLogs).toEqual({ enabled: false });
    expect(policy.telemetryEnabled).toBe(false);
  });

  it("always forces sessionReplay off regardless of input", () => {
    expect(mergePrivacyPolicy(identity, config()).sessionReplay).toEqual({ enabled: false });
  });

  it("caps sampling rates at the platform baseline maximum", () => {
    const policy = mergePrivacyPolicy(
      identity,
      config({ sampling: { sessionSampleRate: 1, errorSampleRate: 1 } }),
    );
    expect(policy.sampling.sessionSampleRate).toBeLessThanOrEqual(
      PLATFORM_PRIVACY_BASELINE.sampling.sessionSampleRate,
    );
    expect(policy.sampling.errorSampleRate).toBeLessThanOrEqual(
      PLATFORM_PRIVACY_BASELINE.sampling.errorSampleRate,
    );
  });

  it("de-duplicates allowed routes/selectors", () => {
    const policy = mergePrivacyPolicy(identity, config());
    expect(policy.excludedRoutes).toEqual(["/a", "/b"]);
  });

  it("carries the host identity through", () => {
    const policy = mergePrivacyPolicy(identity, config());
    expect(policy.service).toBe("demo-frontend");
    expect(policy.environment).toBe("production");
    expect(policy.version).toBe("1.0.0");
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(mergePrivacyPolicy(identity, config()))).toBe(true);
  });
});
