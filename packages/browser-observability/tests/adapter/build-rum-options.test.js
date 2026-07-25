import { describe, expect, it } from "vitest";

import { buildRumOptions } from "../../src/adapter/openobserve/build-rum-options.js";

const identity = Object.freeze({
  service: "browser-app",
  environment: "production",
  version: "1.2.3",
});
const policy = Object.freeze({
  rum: Object.freeze({
    site: "localhost:8443",
    organizationIdentifier: "default",
    applicationId: "chicek-browser-app",
    clientToken: "a".repeat(48),
    apiVersion: "v1",
  }),
  sampling: Object.freeze({ sessionSampleRate: 0.5 }),
});

describe("buildRumOptions", () => {
  it("maps host identity and connection fields through", () => {
    const options = buildRumOptions(identity, policy);
    expect(options.service).toBe("browser-app");
    expect(options.env).toBe("production");
    expect(options.version).toBe("1.2.3");
    expect(options.site).toBe("localhost:8443");
    expect(options.organizationIdentifier).toBe("default");
    expect(options.applicationId).toBe("chicek-browser-app");
    expect(options.clientToken).toBe(policy.rum.clientToken);
    expect(options.apiVersion).toBe("v1");
  });

  it("routes browser-facing ingestion through exact queryless proxy paths", () => {
    const options = buildRumOptions(identity, policy);
    expect(options.proxy({ path: "/rum/v1/default/rum", parameters: "o2-api-key=secret" })).toBe(
      "/rum/v1/default/rum",
    );
  });

  it("scales the 0-1 sessionSampleRate to the SDK's 0-100 percentage", () => {
    expect(buildRumOptions(identity, policy).sessionSampleRate).toBe(50);
  });

  it.each([
    ["insecureHTTP", false],
    ["trackingConsent", "not-granted"],
    ["defaultPrivacyLevel", "mask-user-input"],
    ["sessionReplaySampleRate", 0],
    ["startSessionReplayRecordingManually", true],
    ["allowUntrustedEvents", false],
    ["trackAnonymousUser", false],
  ])("always sets the mandatory security field %s to %p", (key, expected) => {
    expect(buildRumOptions(identity, policy)[key]).toBe(expected);
  });

  it("never sets a user/account identity field", () => {
    const options = buildRumOptions(identity, policy);
    expect(options).not.toHaveProperty("user");
    expect(options).not.toHaveProperty("account");
  });

  it("does not enable distributed tracing or propagation headers", () => {
    const options = buildRumOptions(identity, policy);
    expect(options).not.toHaveProperty("allowedTracingUrls");
    expect(options).not.toHaveProperty("traceSampleRate");
    expect(options).not.toHaveProperty("traceContextInjection");
    expect(options).not.toHaveProperty("propagateTraceBaggage");
  });

  it("clamps an out-of-range or non-numeric sampling rate to 0", () => {
    const weirdPolicy = {
      ...policy,
      sampling: { sessionSampleRate: Number.NaN },
    };
    expect(buildRumOptions(identity, weirdPolicy).sessionSampleRate).toBe(0);
    const negativePolicy = { ...policy, sampling: { sessionSampleRate: -5 } };
    expect(buildRumOptions(identity, negativePolicy).sessionSampleRate).toBe(0);
    const overPolicy = { ...policy, sampling: { sessionSampleRate: 5 } };
    expect(buildRumOptions(identity, overPolicy).sessionSampleRate).toBe(100);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(buildRumOptions(identity, policy))).toBe(true);
  });
});
