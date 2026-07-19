import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  recordError,
  setTrackingConsent,
} from "../src/index.js";
import {
  resetRuntimeRegistryForTests,
  setAdapterFactoryForTests,
} from "../src/bootstrap/runtime-registry.js";
import { sanitizeError } from "../src/sanitization/sanitize-error.js";

const options = {
  service: "company-web",
  environment: "production",
  version: "2026.07.1",
};

beforeEach(() => {
  resetRuntimeRegistryForTests();
  vi.restoreAllMocks();
});

describe("recordError lifecycle", () => {
  it("drops before active without buffering", () => {
    const result = recordError(new Error("boom"));
    expect(result.reasonCode).toBe("NOT_ACTIVE");
    expect(getObservabilityStatus().counters.droppedErrors).toBe(1);
  });

  it("records through the adapter once active and consented", async () => {
    const adapter = fakeAdapter();
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => adapter);
    await initializeObservability(options);
    setTrackingConsent("granted");

    const error = new Error("boom");
    const result = recordError(error, { screen: "checkout" });
    expect(result.ok).toBe(true);
    expect(adapter.recordError).toHaveBeenCalledWith(error, { screen: "checkout" });
    expect(getObservabilityStatus().counters.acceptedErrors).toBe(1);
  });

  it("drops without consent and rejects invalid context", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter());
    await initializeObservability(options);

    expect(recordError(new Error("boom")).reasonCode).toBe("CONSENT_NOT_GRANTED");
    setTrackingConsent("granted");
    expect(recordError(new Error("boom"), []).reasonCode).toBe("INVALID_ERROR");
    expect(getObservabilityStatus().counters.droppedErrors).toBe(2);
  });

  it("isolates adapter throws and degrades", async () => {
    const adapter = fakeAdapter();
    adapter.recordError.mockImplementation(() => {
      throw new Error("adapter failed");
    });
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => adapter);
    await initializeObservability(options);
    setTrackingConsent("granted");

    const result = recordError(new Error("boom"));
    expect(result.reasonCode).toBe("ADAPTER_ERROR");
    expect(getObservabilityStatus().state).toBe("degraded");
    expect(getObservabilityStatus().counters.droppedErrors).toBe(1);
  });

  it("never throws for unusual error values", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter());
    await initializeObservability(options);
    setTrackingConsent("granted");
    for (const value of ["plain string error", null, undefined, { weird: "shape" }]) {
      expect(() => recordError(value)).not.toThrow();
    }
  });
});

describe("sanitizeError", () => {
  it("extracts bounded fields from a real Error", () => {
    const error = new Error("x".repeat(1000));
    Object.defineProperty(error, "stack", { value: "y".repeat(4000) });
    const sanitized = sanitizeError(error);
    expect(sanitized.name).toBe("Error");
    expect(sanitized.message.length).toBeLessThanOrEqual(512);
    expect(sanitized.stack.length).toBeLessThanOrEqual(2048);
  });

  it("falls back for non-string Error fields", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "name", { value: 42 });
    Object.defineProperty(error, "message", { value: 42 });
    Object.defineProperty(error, "stack", { value: 42 });
    expect(sanitizeError(error)).toEqual({
      name: "Error",
      message: "",
      stack: undefined,
    });
  });

  it.each(["plain message", null, undefined, 42, {}, []])(
    "handles non-Error value: %p",
    (value) => {
      expect(sanitizeError(value).name).toEqual(expect.any(String));
    },
  );
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
      site: "observability.example.invalid",
      organizationIdentifier: "org",
      applicationId: "app",
      clientToken: "test client token fixture value",
      apiVersion: "v1",
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
