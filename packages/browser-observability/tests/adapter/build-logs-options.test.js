import { describe, expect, it } from "vitest";

import { buildLogsOptions } from "../../src/adapter/openobserve/build-logs-options.js";

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
  sampling: Object.freeze({ sessionSampleRate: 0.25 }),
});

describe("buildLogsOptions", () => {
  it("maps host identity and connection fields through (no applicationId — logs has none)", () => {
    const options = buildLogsOptions(identity, policy);
    expect(options.service).toBe("browser-app");
    expect(options.env).toBe("production");
    expect(options.version).toBe("1.2.3");
    expect(options.site).toBe("localhost:8443");
    expect(options.organizationIdentifier).toBe("default");
    expect(options.clientToken).toBe(policy.rum.clientToken);
    expect(options.apiVersion).toBe("v1");
    expect(options).not.toHaveProperty("applicationId");
  });

  it("routes browser-facing ingestion through exact queryless proxy paths", () => {
    const options = buildLogsOptions(identity, policy);
    expect(options.proxy({ path: "/rum/v1/default/logs", parameters: "o2-api-key=secret" })).toBe(
      "/rum/v1/default/logs",
    );
  });

  it("scales the 0-1 sessionSampleRate to the SDK's 0-100 percentage", () => {
    expect(buildLogsOptions(identity, policy).sessionSampleRate).toBe(25);
  });

  it("disables all automatic forwarding to avoid double-sending manually recorded errors", () => {
    const options = buildLogsOptions(identity, policy);
    expect(options.forwardErrorsToLogs).toBe(false);
    expect(options.forwardConsoleLogs).toBeUndefined();
    expect(options.forwardReports).toBeUndefined();
  });

  it.each([
    ["insecureHTTP", false],
    ["trackingConsent", "not-granted"],
    ["usePciIntake", false],
    ["allowUntrustedEvents", false],
    ["trackAnonymousUser", false],
  ])("always sets the mandatory security field %s to %p", (key, expected) => {
    expect(buildLogsOptions(identity, policy)[key]).toBe(expected);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(buildLogsOptions(identity, policy))).toBe(true);
  });
});
