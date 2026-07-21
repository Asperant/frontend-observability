import { describe, expect, it } from "vitest";

import {
  checkEdgePublishScope,
  checkHostPortsLoopback,
  checkImagesLockConsistency,
  checkNamedOpenobserveVolume,
  checkNoDangerousPrivileges,
  checkNoFloatingImages,
  checkOpenObserveUiRumDisabled,
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

  it("edge-publish is joined only by reverse-proxy and openobserve, publishing only their two loopback ports", () => {
    const { doc } = loadComposeDocument();
    expect(checkEdgePublishScope(doc)).toEqual({ pass: true, findings: [] });

    const services = doc.services;
    expect(services["reverse-proxy"].networks).toContain("edge-publish");
    expect(services.openobserve.networks).toContain("edge-publish");
    expect(services["demo-frontend"].networks ?? []).not.toContain("edge-publish");
    expect(services["mock-api"].networks ?? []).not.toContain("edge-publish");

    const publishedPorts = Object.values(services).flatMap((service) => service.ports ?? []);
    expect(new Set(publishedPorts)).toEqual(
      new Set(["127.0.0.1:8443:8443", "127.0.0.1:5080:5080"]),
    );
  });

  it("flags demo-frontend or mock-api if they join edge-publish", () => {
    const doc = {
      services: {
        "reverse-proxy": {
          networks: ["app-internal", "edge-publish"],
          ports: ["127.0.0.1:8443:8443"],
        },
        "demo-frontend": { networks: ["app-internal", "edge-publish"] },
        "mock-api": { networks: ["app-internal", "edge-publish"] },
        openobserve: {
          networks: ["observability-internal", "edge-publish"],
          ports: ["127.0.0.1:5080:5080"],
        },
      },
    };
    const result = checkEdgePublishScope(doc);
    expect(result.pass).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("demo-frontend"),
        expect.stringContaining("mock-api"),
      ]),
    );
  });

  it("flags reverse-proxy or openobserve if they are missing from edge-publish", () => {
    const doc = {
      services: {
        "reverse-proxy": { networks: ["app-internal"], ports: ["127.0.0.1:8443:8443"] },
        "demo-frontend": { networks: ["app-internal"] },
        "mock-api": { networks: ["app-internal"] },
        openobserve: { networks: ["observability-internal"], ports: ["127.0.0.1:5080:5080"] },
      },
    };
    const result = checkEdgePublishScope(doc);
    expect(result.pass).toBe(false);
    expect(result.findings.some((f) => f.includes("reverse-proxy"))).toBe(true);
    expect(result.findings.some((f) => f.includes("openobserve"))).toBe(true);
  });

  it("flags an unexpected published port", () => {
    const doc = {
      services: {
        "reverse-proxy": {
          networks: ["edge-publish"],
          ports: ["127.0.0.1:8443:8443", "127.0.0.1:9999:9999"],
        },
        openobserve: { networks: ["edge-publish"], ports: ["127.0.0.1:5080:5080"] },
      },
    };
    const result = checkEdgePublishScope(doc);
    expect(result.pass).toBe(false);
    expect(result.findings.some((f) => f.includes("9999"))).toBe(true);
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

  it("keeps OpenObserve's own admin UI RUM instrumentation disabled", () => {
    const { doc } = loadComposeDocument();
    expect(checkOpenObserveUiRumDisabled(doc)).toEqual({ pass: true, findings: [] });
  });

  it("flags OpenObserve admin UI RUM instrumentation if it is reintroduced", () => {
    const doc = {
      services: {
        openobserve: {
          environment: {
            ZO_RUM_ENABLED: "true",
            ZO_RUM_SITE: "localhost:8443",
          },
        },
      },
    };
    const result = checkOpenObserveUiRumDisabled(doc);
    expect(result.pass).toBe(false);
    expect(result.findings).toEqual([
      expect.stringContaining("ZO_RUM_ENABLED"),
      expect.stringContaining("ZO_RUM_SITE"),
    ]);
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
