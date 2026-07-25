import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRouter } from "./helpers/control-fetch.js";

import {
  getObservabilityStatus,
  initializeObservability,
  setTrackingConsent,
} from "../src/index.js";
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

describe("setTrackingConsent", () => {
  it.each(["granted", "not-granted"])("accepts %s in memory", (consent) => {
    const result = setTrackingConsent(consent);
    expect(result.ok).toBe(true);
    expect(getObservabilityStatus().consent).toBe(consent);
  });

  it.each([null, undefined, "denied", "unknown", 1, {}])(
    "rejects invalid consent %p",
    (consent) => {
      const before = getObservabilityStatus().consent;
      const result = setTrackingConsent(consent);
      expect(result.ok).toBe(false);
      expect(result.reasonCode).toBe("INVALID_CONSENT");
      expect(getObservabilityStatus().consent).toBe(before);
    },
  );

  it("uses pre-init consent and forwards post-init changes to the adapter", async () => {
    const adapter = fakeAdapter();
    globalThis.fetch = vi.fn(
      fetchRouter(() => Promise.resolve(jsonResponse(validEnabledConfig()))),
    );
    setAdapterFactoryForTests(() => adapter);

    setTrackingConsent("granted");
    await initializeObservability(options);
    expect(adapter.initialize.mock.calls[0][0].consent).toBe("granted");

    setTrackingConsent("not-granted");
    expect(adapter.stopSessionReplay).toHaveBeenCalledTimes(1);
    expect(adapter.setTrackingConsent).toHaveBeenCalledWith("not-granted");
  });

  it("isolates adapter consent throws", async () => {
    const adapter = fakeAdapter();
    adapter.setTrackingConsent.mockImplementation(() => {
      throw new Error("adapter failed");
    });
    globalThis.fetch = vi.fn(
      fetchRouter(() => Promise.resolve(jsonResponse(validEnabledConfig()))),
    );
    setAdapterFactoryForTests(() => adapter);

    await initializeObservability(options);
    const result = setTrackingConsent("granted");
    expect(result.ok).toBe(true);
    expect(getObservabilityStatus().state).toBe("degraded");

    const again = setTrackingConsent("not-granted");
    expect(again.ok).toBe(true);
    expect(getObservabilityStatus().state).toBe("degraded");
  });

  it("does not use browser storage", () => {
    const localStorageSpy = vi.spyOn(globalThis.window, "localStorage", "get");
    const sessionStorageSpy = vi.spyOn(globalThis.window, "sessionStorage", "get");
    setTrackingConsent("granted");
    expect(localStorageSpy).not.toHaveBeenCalled();
    expect(sessionStorageSpy).not.toHaveBeenCalled();
  });

  it("fails closed without granting consent when epoch creation is unavailable", () => {
    vi.stubGlobal("crypto", {});
    const result = setTrackingConsent("granted");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("CORRELATION_CONTEXT_UNAVAILABLE");
    expect(getObservabilityStatus().consent).toBe("not-granted");
    expect(getObservabilityStatus().correlation.state).toBe("unavailable");
    vi.unstubAllGlobals();
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
    sampling: { sessionSampleRate: 0.5 },
    rum: {
      site: "observability.example.invalid",
      organizationIdentifier: "org",
      applicationId: "app",
      clientToken: "test client token fixture value",
      apiVersion: "v1",
    },
    browserLogs: { enabled: false },
    sessionReplay: { enabled: false },
    sensitiveRoutes: [],
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
