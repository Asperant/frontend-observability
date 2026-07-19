import { beforeEach, describe, expect, it, vi } from "vitest";

import { getObservabilityStatus, initializeObservability } from "../../src/index.js";
import {
  resetRuntimeRegistryForTests,
  setAdapterFactoryForTests,
} from "../../src/bootstrap/runtime-registry.js";

const options = {
  service: "company-web",
  environment: "production",
  version: "2026.07.1",
};

beforeEach(() => {
  resetRuntimeRegistryForTests();
  vi.restoreAllMocks();
});

function fakeAdapter(capabilities) {
  return {
    name: "fake",
    initialize: vi.fn(),
    setTrackingConsent: vi.fn(),
    recordAction: vi.fn(),
    recordError: vi.fn(),
    startSessionReplay: vi.fn(),
    stopSessionReplay: vi.fn(),
    shutdown: vi.fn(),
    getCapabilities: vi.fn(() => capabilities),
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
      site: "observability.example.invalid",
      organizationIdentifier: "org",
      applicationId: "app",
      clientToken: "test client token fixture value",
      apiVersion: "v1",
    },
    browserLogs: { enabled: true },
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

describe("coordinator capability-driven state (generic, adapter-agnostic)", () => {
  it("stays active when the adapter reports telemetry available and logs not degraded", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() =>
      fakeAdapter({ telemetry: true, logs: true, sessionReplay: false }),
    );

    const result = await initializeObservability(options);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("active");
    expect(getObservabilityStatus().reasonCode).toBe("NONE");
  });

  it("degrades when telemetry is available but logs explicitly failed", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() =>
      fakeAdapter({ telemetry: true, logs: false, sessionReplay: false }),
    );

    const result = await initializeObservability(options);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("degraded");
    expect(getObservabilityStatus().reasonCode).toBe("ADAPTER_ERROR");
    // Still recording: degraded is not disabled.
    expect(getObservabilityStatus().enabled).toBe(true);
  });

  it("stays active when getCapabilities is missing/empty (adapters that don't report logs at all)", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter({}));

    const result = await initializeObservability(options);
    expect(result.state).toBe("active");
  });

  it("tolerates getCapabilities() returning a non-object without crashing the initialize flow", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter(null));

    const result = await initializeObservability(options);
    expect(result.state).toBe("active");
  });

  it("tolerates getCapabilities() throwing without crashing the initialize flow", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    const adapter = fakeAdapter({});
    adapter.getCapabilities.mockImplementation(() => {
      throw new Error("boom");
    });
    setAdapterFactoryForTests(() => adapter);

    const result = await initializeObservability(options);
    expect(result.state).toBe("active");
  });

  it("degrades gracefully when the adapter factory itself throws synchronously (not just adapter.initialize())", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => {
      throw new Error("factory boom");
    });

    const result = await initializeObservability(options);
    expect(result.ok).toBe(false);
    expect(result.state).toBe("degraded");
    expect(result.reasonCode).toBe("ADAPTER_ERROR");
  });

  it("disables (not degrades) with a controlled reasonCode when the adapter's own init reports a recognized failure", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    const adapter = fakeAdapter({});
    adapter.initialize.mockImplementation(() => {
      const error = new Error("openobserve adapter initialization failed");
      error.reasonCode = "ADAPTER_INITIALIZATION_FAILED";
      throw error;
    });
    setAdapterFactoryForTests(() => adapter);

    const result = await initializeObservability(options);
    expect(result.ok).toBe(false);
    expect(result.state).toBe("disabled");
    expect(result.reasonCode).toBe("ADAPTER_INITIALIZATION_FAILED");
  });
});
