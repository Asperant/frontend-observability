import { describe, expect, it } from "vitest";

import {
  checkHostPortsLoopback,
  checkImagesLockConsistency,
  checkNamedOpenobserveVolume,
  checkNoDangerousPrivileges,
  checkNoFloatingImages,
  checkResourceAndReliabilityLimits,
  checkSingleComposeFile,
  loadComposeDocument,
  loadImagesLock,
  runAllStaticChecks,
} from "../../scripts/lab/static-checks.mjs";

describe("static compose safety checks (against the real infrastructure/docker/compose.yaml)", () => {
  it("passes every static check as a whole", () => {
    const result = runAllStaticChecks();
    expect(result.findings).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it("has exactly one canonical compose file and no override/release/hotfix/rollback file", () => {
    expect(checkSingleComposeFile()).toEqual({ pass: true, findings: [] });
  });

  it("pins every external image to an exact, non-floating tag", () => {
    const { doc } = loadComposeDocument();
    expect(checkNoFloatingImages(doc).pass).toBe(true);
  });

  it("flags a floating tag if one is introduced", () => {
    const doc = {
      services: { openobserve: { image: "public.ecr.aws/zinclabs/openobserve:latest" } },
    };
    const result = checkNoFloatingImages(doc);
    expect(result.pass).toBe(false);
    expect(result.findings[0]).toMatch(/floating\/prerelease/);
  });

  it("cross-references every Dockerfile FROM line against images.lock.json", () => {
    expect(checkImagesLockConsistency()).toEqual({ pass: true, findings: [] });
  });

  it("binds every published host port to 127.0.0.1 only", () => {
    const { doc } = loadComposeDocument();
    expect(checkHostPortsLoopback(doc)).toEqual({ pass: true, findings: [] });
  });

  it("flags a wildcard host binding", () => {
    const doc = { services: { web: { ports: ["0.0.0.0:8080:8080"] } } };
    const result = checkHostPortsLoopback(doc);
    expect(result.pass).toBe(false);
  });

  it("has no privileged mode, docker socket mount, host networking, or cap_add", () => {
    const { doc } = loadComposeDocument();
    expect(checkNoDangerousPrivileges(doc)).toEqual({ pass: true, findings: [] });
  });

  it("flags cap_add if introduced", () => {
    const doc = { services: { web: { cap_add: ["NET_ADMIN"] } } };
    expect(checkNoDangerousPrivileges(doc).pass).toBe(false);
  });

  it("every service has real (non-Swarm-only) resource/pid/log/healthcheck/restart limits", () => {
    const { doc } = loadComposeDocument();
    expect(checkResourceAndReliabilityLimits(doc)).toEqual({ pass: true, findings: [] });
  });

  it("openobserve-data is a named volume mounted at /data, not a bind mount", () => {
    const { doc } = loadComposeDocument();
    expect(checkNamedOpenobserveVolume(doc)).toEqual({ pass: true, findings: [] });
  });

  it("images.lock.json has the expected schema shape", () => {
    const lock = loadImagesLock();
    expect(lock.schemaVersion).toBe(1);
    expect(Array.isArray(lock.images)).toBe(true);
    for (const entry of lock.images) {
      expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.platform).toBe("linux/amd64");
      expect(entry.prerelease).toBe(false);
    }
  });
});
