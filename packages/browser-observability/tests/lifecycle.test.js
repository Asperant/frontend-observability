import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  shutdownObservability,
} from "../src/index.js";
import { RUNTIME_SYMBOL, resetRuntimeRegistryForTests } from "../src/bootstrap/runtime-registry.js";
import { canTransition, LifecycleStates } from "../src/lifecycle/transitions.js";

const options = {
  configUrl: "/observability/config.json",
  service: "company-web",
  environment: "production",
  version: "2026.07.1",
};

beforeEach(() => {
  resetRuntimeRegistryForTests();
  vi.restoreAllMocks();
});

describe("state machine transitions", () => {
  it("declares allowed lifecycle transitions", () => {
    expect(canTransition("idle", "initializing")).toBe(true);
    expect(canTransition("initializing", "active")).toBe(true);
    expect(canTransition("initializing", "disabled")).toBe(true);
    expect(canTransition("initializing", "degraded")).toBe(true);
    expect(canTransition("active", "shutting-down")).toBe(true);
    expect(canTransition("degraded", "shutting-down")).toBe(true);
    expect(canTransition("disabled", "shutting-down")).toBe(true);
    expect(canTransition("shutting-down", "shutdown")).toBe(true);
    expect(canTransition("shutdown", "initializing")).toBe(true);
    expect(canTransition("active", "idle")).toBe(false);
  });

  it("starts idle and creates the package-duplication registry only on initialize", async () => {
    expect(getObservabilityStatus().state).toBe(LifecycleStates.IDLE);
    expect(globalThis[RUNTIME_SYMBOL]).toBeUndefined();
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    const result = await initializeObservability(options);
    expect(result.reasonCode).toBe("ADAPTER_UNAVAILABLE");
    expect(globalThis[RUNTIME_SYMBOL]).toMatchObject({
      lifecycleGeneration: 1,
      fingerprint: expect.any(String),
      inFlightPromise: null,
    });
  });

  it("is idempotent and allows reinitialization after shutdown", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validDisabledConfig())));
    await initializeObservability(options);
    expect(getObservabilityStatus().state).toBe("disabled");

    const first = await shutdownObservability();
    const second = await shutdownObservability();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(getObservabilityStatus().state).toBe("shutdown");

    const reinit = await initializeObservability(options);
    expect(reinit.reasonCode).toBe("CONFIG_DISABLED");
  });
});

function validEnabledConfig() {
  return {
    ...validDisabledConfig(),
    configVersion: "valid-enabled",
    enabled: true,
    killSwitch: { engaged: false },
    sampling: { sessionSampleRate: 0.5, errorSampleRate: 0.5 },
    rum: {
      endpoint: "https://observability.example.invalid/rum",
      applicationId: "app",
      organizationId: "org",
    },
  };
}

function validDisabledConfig() {
  return {
    schemaVersion: "1.0.0",
    configVersion: "valid-disabled",
    enabled: false,
    issuedAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    killSwitch: { engaged: true },
    privacyProfile: "strict",
    sampling: { sessionSampleRate: 0, errorSampleRate: 0 },
    rum: {},
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
