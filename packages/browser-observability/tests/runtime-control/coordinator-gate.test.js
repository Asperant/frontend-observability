import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  recordError,
  setTrackingConsent,
  shutdownObservability,
} from "../../src/index.js";
import {
  resetRuntimeRegistryForTests,
  setAdapterFactoryForTests,
} from "../../src/bootstrap/runtime-registry.js";
import { CONTROL_ENDPOINT_PATH } from "../../src/runtime-control/constants.js";
import {
  ensureControlRegistry,
  resetControlRegistryForTests,
} from "../../src/runtime-control/registry.js";

const options = {
  service: "company-web",
  environment: "production",
  version: "2026.07.1",
};

beforeEach(() => {
  resetRuntimeRegistryForTests();
  resetControlRegistryForTests();
  vi.restoreAllMocks();
});

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

function isControlUrl(url) {
  return new URL(String(url), "https://control.invalid").pathname === CONTROL_ENDPOINT_PATH;
}

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

describe("coordinator: runtime-control gates activation", () => {
  it("never activates telemetry when the first control document fails to load", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (isControlUrl(url)) return Promise.resolve(new Response("{}", { status: 503 }));
      return Promise.resolve(jsonResponse(validEnabledConfig()));
    });
    setAdapterFactoryForTests(() => fakeAdapter());

    const result = await initializeObservability(options);
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("RUNTIME_CONTROL_UNAVAILABLE");
    expect(getObservabilityStatus().state).toBe("disabled");
    // The adapter (and its network side effects) must never have been touched.
    expect(getObservabilityStatus().adapter).toBeNull();
  });

  it("activates normally once both the runtime config and the control document are valid", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (isControlUrl(url)) {
        const now = new Date();
        return Promise.resolve(
          jsonResponse({
            schemaVersion: 1,
            revision: 1,
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
            killSwitch: { active: false, reasonCode: "none" },
          }),
        );
      }
      return Promise.resolve(jsonResponse(validEnabledConfig()));
    });
    setAdapterFactoryForTests(() => fakeAdapter());

    const result = await initializeObservability(options);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("active");
    expect(getObservabilityStatus().runtimeControl.state).toBe("fresh");

    await shutdownObservability();
  });

  it("recordAction()/recordError() no-op with RUNTIME_CONTROL_GATE_CLOSED once the kill switch latches, without ever reaching the adapter", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (isControlUrl(url)) {
        const now = new Date();
        return Promise.resolve(
          jsonResponse({
            schemaVersion: 1,
            revision: 1,
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
            killSwitch: { active: false, reasonCode: "none" },
          }),
        );
      }
      return Promise.resolve(jsonResponse(validEnabledConfig()));
    });
    const adapter = fakeAdapter();
    setAdapterFactoryForTests(() => adapter);

    await initializeObservability(options);
    setTrackingConsent("granted");

    // Simulate the kill switch latching (as a real refresh cycle would) by
    // mutating the page-lifetime control registry directly, without going
    // through shutdown/reinitialize.
    const registry = ensureControlRegistry();
    registry.killSwitchLatched = true;
    registry.killSwitchActive = true;
    registry.killSwitchReasonCode = "security_incident";

    const actionResult = recordAction("demo.action", { ok: true });
    const errorResult = recordError(new Error("boom"));
    expect(actionResult.reasonCode).toBe("RUNTIME_CONTROL_GATE_CLOSED");
    expect(errorResult.reasonCode).toBe("RUNTIME_CONTROL_GATE_CLOSED");
    expect(adapter.recordAction).not.toHaveBeenCalled();
    expect(adapter.recordError).not.toHaveBeenCalled();
    expect(getObservabilityStatus().runtimeControl.killSwitch).toEqual({
      active: true,
      latched: true,
      reasonCode: "security_incident",
    });
    // The host page keeps running: the lifecycle state itself is untouched.
    expect(getObservabilityStatus().state).toBe("active");

    await shutdownObservability();
  });
});
