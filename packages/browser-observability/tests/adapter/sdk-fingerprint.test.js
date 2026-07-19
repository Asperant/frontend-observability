import { describe, expect, it } from "vitest";

import { computeSdkFingerprint } from "../../src/adapter/openobserve/sdk-fingerprint.js";

const identity = Object.freeze({
  service: "demo-frontend",
  environment: "lab",
  version: "2026.07.1",
});

const rumConfig = Object.freeze({
  site: "localhost:8443",
  organizationIdentifier: "default",
  applicationId: "chicek-demo-frontend",
  clientToken: "a".repeat(48),
  apiVersion: "v1",
});

describe("computeSdkFingerprint", () => {
  it("is deterministic for the same identity and connection", () => {
    expect(computeSdkFingerprint(identity, rumConfig)).toBe(
      computeSdkFingerprint(identity, rumConfig),
    );
  });

  it("never contains the raw clientToken value", () => {
    const fingerprint = computeSdkFingerprint(identity, rumConfig);
    expect(fingerprint).not.toContain(rumConfig.clientToken);
  });

  it("changes when the clientToken changes, even if every other field is identical", () => {
    const other = { ...rumConfig, clientToken: "b".repeat(48) };
    expect(computeSdkFingerprint(identity, rumConfig)).not.toBe(
      computeSdkFingerprint(identity, other),
    );
  });

  it("changes when site changes", () => {
    const other = { ...rumConfig, site: "otherhost:8443" };
    expect(computeSdkFingerprint(identity, rumConfig)).not.toBe(
      computeSdkFingerprint(identity, other),
    );
  });

  it("changes when organizationIdentifier changes", () => {
    const other = { ...rumConfig, organizationIdentifier: "other" };
    expect(computeSdkFingerprint(identity, rumConfig)).not.toBe(
      computeSdkFingerprint(identity, other),
    );
  });

  it("changes when applicationId changes", () => {
    const other = { ...rumConfig, applicationId: "other-app" };
    expect(computeSdkFingerprint(identity, rumConfig)).not.toBe(
      computeSdkFingerprint(identity, other),
    );
  });

  it("changes when service changes", () => {
    const other = { ...identity, service: "other-service" };
    expect(computeSdkFingerprint(identity, rumConfig)).not.toBe(
      computeSdkFingerprint(other, rumConfig),
    );
  });

  it("changes when environment changes", () => {
    const other = { ...identity, environment: "production" };
    expect(computeSdkFingerprint(identity, rumConfig)).not.toBe(
      computeSdkFingerprint(other, rumConfig),
    );
  });

  it("changes when version changes", () => {
    const other = { ...identity, version: "2026.08.1" };
    expect(computeSdkFingerprint(identity, rumConfig)).not.toBe(
      computeSdkFingerprint(other, rumConfig),
    );
  });
});
