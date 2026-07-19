import { beforeEach, describe, expect, it, vi } from "vitest";

import { isValidActionName } from "../src/actions/validate-action-name.js";
import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
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

describe("custom action naming rules", () => {
  it.each(["checkout.submit", "click", "form_field_focus", "a.b.c"])(
    "accepts a well-formed name: %s",
    (name) => {
      expect(isValidActionName(name)).toBe(true);
    },
  );

  it.each(["", "Checkout.Submit", "checkout submit", "1checkout", ".checkout", null, 42])(
    "rejects a malformed name: %p",
    (name) => {
      expect(isValidActionName(name)).toBe(false);
    },
  );
});

describe("recordAction lifecycle", () => {
  it("drops before active without buffering", () => {
    const result = recordAction("checkout.submit", {});
    expect(result.reasonCode).toBe("NOT_ACTIVE");
    expect(getObservabilityStatus().counters.droppedActions).toBe(1);
  });

  it("drops without granted consent", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter());
    await initializeObservability(options);

    const result = recordAction("checkout.submit", {});
    expect(result.reasonCode).toBe("CONSENT_NOT_GRANTED");
    expect(getObservabilityStatus().counters.droppedActions).toBe(1);
  });

  it("records through the adapter once active and consented", async () => {
    const adapter = fakeAdapter();
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => adapter);
    await initializeObservability(options);
    setTrackingConsent("granted");

    const result = recordAction("checkout.submit", { itemCount: 3 });
    expect(result.ok).toBe(true);
    expect(adapter.recordAction).toHaveBeenCalledWith("checkout.submit", { itemCount: 3 });
    recordAction("checkout.null_attributes", null);
    expect(adapter.recordAction).toHaveBeenCalledWith("checkout.null_attributes", {});
    expect(getObservabilityStatus().counters.acceptedActions).toBe(2);
  });

  it("drops structurally invalid active actions", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter());
    await initializeObservability(options);
    setTrackingConsent("granted");

    expect(recordAction("Not Valid!", {}).reasonCode).toBe("INVALID_ACTION");
    expect(recordAction("checkout.submit", []).reasonCode).toBe("INVALID_ACTION");
    expect(getObservabilityStatus().counters.droppedActions).toBe(2);
  });

  it("isolates adapter throws and degrades", async () => {
    const adapter = fakeAdapter();
    adapter.recordAction.mockImplementation(() => {
      throw new Error("adapter failed");
    });
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => adapter);
    await initializeObservability(options);
    setTrackingConsent("granted");

    const result = recordAction("checkout.submit", {});
    expect(result.reasonCode).toBe("ADAPTER_ERROR");
    expect(getObservabilityStatus().state).toBe("degraded");
    expect(getObservabilityStatus().counters.droppedActions).toBe(1);
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
