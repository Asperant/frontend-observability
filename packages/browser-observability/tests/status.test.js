import { beforeEach, describe, expect, it, vi } from "vitest";

import { getObservabilityStatus, initializeObservability } from "../src/index.js";
import {
  resetRuntimeRegistryForTests,
  setAdapterFactoryForTests,
} from "../src/bootstrap/runtime-registry.js";

const options = {
  service: "company-web",
  environment: "production",
  version: "2026.07.1",
};

beforeEach(() => {
  resetRuntimeRegistryForTests();
  vi.restoreAllMocks();
});

describe("getObservabilityStatus", () => {
  it("reports an immutable idle snapshot with default consent", () => {
    const status = getObservabilityStatus();
    expect(status.state).toBe("idle");
    expect(status.consent).toBe("not-granted");
    expect(status.service).toBeNull();
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.counters)).toBe(true);
    expect(() => {
      status.counters.acceptedActions = -1;
    }).toThrow(TypeError);
  });

  it("reports active runtime identity without exposing config payload", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter());

    await initializeObservability(options);
    const status = getObservabilityStatus();
    expect(status).toMatchObject({
      state: "active",
      enabled: true,
      service: "company-web",
      environment: "production",
      version: "2026.07.1",
      configVersion: "valid-enabled",
      adapter: "fake",
      reasonCode: "NONE",
    });
    expect(JSON.stringify(status)).not.toContain("https://observability.example.invalid");
    expect(status.initializedAt).toEqual(expect.any(String));
    expect(status.lastTransitionAt).toEqual(expect.any(String));
  });
});

function fakeAdapter() {
  return {
    name: "fake",
    initialize: vi.fn(),
    setTrackingConsent: vi.fn(),
    recordAction: vi.fn(),
    recordError: vi.fn(),
    startSessionReplay: vi.fn(),
    stopSessionReplay: vi.fn(),
    shutdown: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
  };
}

function validEnabledConfig() {
  return {
    schemaVersion: "1.0.0",
    configVersion: "valid-enabled",
    enabled: true,
    issuedAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    killSwitch: { engaged: false },
    privacyProfile: "strict",
    sampling: { sessionSampleRate: 0.5, errorSampleRate: 0.5 },
    rum: {
      endpoint: "https://observability.example.invalid/rum",
      applicationId: "app",
      organizationId: "org",
    },
    browserLogs: { enabled: false },
    sessionReplay: { enabled: false },
    allowedRoutes: [],
    allowedSelectors: [],
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
