import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeSdkFingerprint,
  isFingerprintingSupported,
} from "../../src/adapter/openobserve/sdk-fingerprint.js";

const identity = Object.freeze({
  service: "browser-app",
  environment: "lab",
  version: "2026.07.1",
});

const rumConfig = Object.freeze({
  site: "localhost:8443",
  organizationIdentifier: "default",
  applicationId: "frontend-observability-browser-app",
  clientToken: "a".repeat(48),
  apiVersion: "v1",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("computeSdkFingerprint", () => {
  it("is a 64-character hex SHA-256 digest, deterministic for the same identity and connection", async () => {
    const first = await computeSdkFingerprint(identity, rumConfig);
    const second = await computeSdkFingerprint(identity, rumConfig);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never contains the raw clientToken value", async () => {
    const fingerprint = await computeSdkFingerprint(identity, rumConfig);
    expect(fingerprint).not.toContain(rumConfig.clientToken);
  });

  it("changes when the clientToken changes, even if every other field is identical", async () => {
    const other = { ...rumConfig, clientToken: "b".repeat(48) };
    expect(await computeSdkFingerprint(identity, rumConfig)).not.toBe(
      await computeSdkFingerprint(identity, other),
    );
  });

  it("changes when site changes", async () => {
    const other = { ...rumConfig, site: "otherhost:8443" };
    expect(await computeSdkFingerprint(identity, rumConfig)).not.toBe(
      await computeSdkFingerprint(identity, other),
    );
  });

  it("changes when organizationIdentifier changes", async () => {
    const other = { ...rumConfig, organizationIdentifier: "other" };
    expect(await computeSdkFingerprint(identity, rumConfig)).not.toBe(
      await computeSdkFingerprint(identity, other),
    );
  });

  it("changes when applicationId changes", async () => {
    const other = { ...rumConfig, applicationId: "other-app" };
    expect(await computeSdkFingerprint(identity, rumConfig)).not.toBe(
      await computeSdkFingerprint(identity, other),
    );
  });

  it("changes when service changes", async () => {
    const other = { ...identity, service: "other-service" };
    expect(await computeSdkFingerprint(identity, rumConfig)).not.toBe(
      await computeSdkFingerprint(other, rumConfig),
    );
  });

  it("changes when environment changes", async () => {
    const other = { ...identity, environment: "production" };
    expect(await computeSdkFingerprint(identity, rumConfig)).not.toBe(
      await computeSdkFingerprint(other, rumConfig),
    );
  });

  it("changes when version changes", async () => {
    const other = { ...identity, version: "2026.08.1" };
    expect(await computeSdkFingerprint(identity, rumConfig)).not.toBe(
      await computeSdkFingerprint(other, rumConfig),
    );
  });

  it("does not collide when a delimiter-like character moves across a field boundary", async () => {
    // Without a length-prefix, concatenating with a plain separator (e.g.
    // "|") would let these two configs canonicalize identically:
    //   site="x|y", organizationIdentifier="z"
    //   site="x",   organizationIdentifier="y|z"
    // The length-prefixed encoding must keep them distinct.
    const configA = { ...rumConfig, site: "x|y", organizationIdentifier: "z" };
    const configB = { ...rumConfig, site: "x", organizationIdentifier: "y|z" };
    expect(await computeSdkFingerprint(identity, configA)).not.toBe(
      await computeSdkFingerprint(identity, configB),
    );
  });

  it("does not collide when a field boundary shifts across two adjacent fields entirely", async () => {
    const configA = { ...rumConfig, site: "ab", organizationIdentifier: "cd" };
    const configB = { ...rumConfig, site: "a", organizationIdentifier: "bcd" };
    expect(await computeSdkFingerprint(identity, configA)).not.toBe(
      await computeSdkFingerprint(identity, configB),
    );
  });

  it("fails closed (rejects) when crypto.subtle is not available, without falling back to a weaker hash", async () => {
    vi.stubGlobal("crypto", {});
    expect(isFingerprintingSupported()).toBe(false);
    await expect(computeSdkFingerprint(identity, rumConfig)).rejects.toThrow();
  });
});
