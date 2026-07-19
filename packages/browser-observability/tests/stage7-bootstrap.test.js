import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  shutdownObservability,
} from "../src/index.js";
import {
  isJsonContentType,
  loadConfig,
  validateRuntimeConfigShape,
} from "../src/config/load-config.js";
import { validateLifetime } from "../src/config/validate-lifetime.js";
import { transition } from "../src/lifecycle/state-machine.js";
import {
  getExistingRuntimeRegistry,
  resetRuntimeRegistryForTests,
  setAdapterFactoryForTests,
} from "../src/bootstrap/runtime-registry.js";
import { createUnavailableAdapter } from "../src/adapter/unavailable-adapter.js";
import { activateRuntime, createInitialRuntimeState } from "../src/lifecycle/state-machine.js";

const options = {
  service: "company-web",
  environment: "production",
  version: "2026.07.1",
};

beforeEach(() => {
  resetRuntimeRegistryForTests();
  vi.restoreAllMocks();
});

describe("runtime config loading", () => {
  it("uses the required fetch security options", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    await loadConfig("/observability/config.json");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/observability/config.json",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    ["CONFIG_HTTP_ERROR", () => new Response("{}", { status: 500, headers: jsonHeaders() })],
    ["CONFIG_CONTENT_TYPE_INVALID", () => new Response("{}", { status: 200 })],
    ["CONFIG_JSON_INVALID", () => new Response("{", { status: 200, headers: jsonHeaders() })],
    ["CONFIG_SCHEMA_INVALID", () => jsonResponse({ ...validEnabledConfig(), unexpected: true })],
    [
      "CONFIG_EXPIRED",
      () =>
        jsonResponse({
          ...validEnabledConfig(),
          issuedAt: "2019-01-01T00:00:00.000Z",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
    ],
    [
      "CONFIG_NOT_YET_VALID",
      () =>
        jsonResponse({
          ...validEnabledConfig(),
          issuedAt: "2099-01-01T00:00:00.000Z",
          expiresAt: "2099-01-02T00:00:00.000Z",
        }),
    ],
  ])("returns %s without leaking payloads", async (reasonCode, responseFactory) => {
    globalThis.fetch = vi.fn(() => Promise.resolve(responseFactory()));
    const result = await initializeObservability(options);
    expect(result.reasonCode).toBe(reasonCode);
    expect(getObservabilityStatus().state).toBe("disabled");
    expect(JSON.stringify(getObservabilityStatus())).not.toContain("endpoint");
  });

  it("enforces the 64 KiB body limit", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ filler: "x".repeat(70 * 1024) }), {
          status: 200,
          headers: jsonHeaders(),
        }),
      ),
    );
    const result = await initializeObservability(options);
    expect(result.reasonCode).toBe("CONFIG_TOO_LARGE");
  });

  it("times out slow config fetches", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const promise = initializeObservability(options);
    await vi.advanceTimersByTimeAsync(2001);
    await expect(promise).resolves.toEqual(
      expect.objectContaining({ reasonCode: "CONFIG_TIMEOUT" }),
    );
    vi.useRealTimers();
  });

  it("accepts +json content types and supports text-only responses", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        status: 200,
        redirected: false,
        headers: { get: () => "application/runtime+json; charset=utf-8" },
        text: () => Promise.resolve(JSON.stringify(validDisabledConfig())),
      }),
    );
    await expect(loadConfig("/observability/config.json")).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(isJsonContentType("application/vnd.test+json")).toBe(true);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  it("enforces body limits for text-only responses", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        status: 200,
        redirected: false,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve("x".repeat(70 * 1024)),
      }),
    );
    await expect(loadConfig("/observability/config.json")).resolves.toEqual(
      expect.objectContaining({ reasonCode: "CONFIG_TOO_LARGE" }),
    );
  });

  it("maps redirected, abort, and unavailable fetch failures", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        status: 200,
        redirected: true,
        headers: { get: () => "application/json" },
      }),
    );
    await expect(loadConfig("/observability/config.json")).resolves.toEqual(
      expect.objectContaining({ reasonCode: "CONFIG_HTTP_ERROR" }),
    );

    globalThis.fetch = vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await expect(loadConfig("/observability/config.json")).resolves.toEqual(
      expect.objectContaining({ reasonCode: "CONFIG_TIMEOUT" }),
    );

    globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline")));
    await expect(loadConfig("/observability/config.json")).resolves.toEqual(
      expect.objectContaining({ reasonCode: "CONFIG_UNAVAILABLE" }),
    );
  });
});

describe("runtime config schema and lifetime helpers", () => {
  it("accepts valid enabled and disabled config shapes", () => {
    expect(validateRuntimeConfigShape(validEnabledConfig())).toBe(true);
    expect(validateRuntimeConfigShape(validDisabledConfig())).toBe(true);
  });

  it("rejects unknown keys, replay enablement, and missing enabled RUM credentials", () => {
    expect(validateRuntimeConfigShape({ ...validDisabledConfig(), unknown: true })).toBe(false);
    expect(
      validateRuntimeConfigShape({
        ...validEnabledConfig(),
        sessionReplay: { enabled: true },
      }),
    ).toBe(false);
    expect(validateRuntimeConfigShape({ ...validEnabledConfig(), rum: {} })).toBe(false);
  });

  it("rejects malformed runtime config branches", () => {
    const base = validEnabledConfig();
    expect(validateRuntimeConfigShape(null)).toBe(false);
    expect(validateRuntimeConfigShape([])).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, schemaVersion: "2.0.0" })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, configVersion: "" })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, enabled: "true" })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, issuedAt: "" })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, killSwitch: null })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, killSwitch: { engaged: "yes" } })).toBe(false);
    expect(
      validateRuntimeConfigShape({ ...base, killSwitch: { engaged: false, extra: true } }),
    ).toBe(false);
    expect(
      validateRuntimeConfigShape({
        ...base,
        killSwitch: { engaged: false, reason: "x".repeat(300) },
      }),
    ).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, privacyProfile: "allow" })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, sampling: null })).toBe(false);
    expect(
      validateRuntimeConfigShape({
        ...base,
        sampling: { sessionSampleRate: 2, errorSampleRate: 0 },
      }),
    ).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, rum: null })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, rum: { ...base.rum, extra: true } })).toBe(false);
    expect(
      validateRuntimeConfigShape({ ...base, rum: { ...base.rum, endpoint: "http://bad" } }),
    ).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, browserLogs: null })).toBe(false);
    expect(
      validateRuntimeConfigShape({ ...base, browserLogs: { enabled: false, extra: true } }),
    ).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, sessionReplay: null })).toBe(false);
    expect(
      validateRuntimeConfigShape({ ...base, sessionReplay: { enabled: false, extra: true } }),
    ).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, allowedRoutes: "all" })).toBe(false);
    expect(validateRuntimeConfigShape({ ...base, allowedSelectors: ["x".repeat(300)] })).toBe(
      false,
    );
  });

  it("validates config lifetime with clock skew", () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    expect(validateLifetime(validEnabledConfig(), now).valid).toBe(true);
    expect(
      validateLifetime(
        {
          ...validEnabledConfig(),
          issuedAt: "2019-01-01T00:00:00.000Z",
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
        now,
      ).reasonCode,
    ).toBe("CONFIG_EXPIRED");
    expect(
      validateLifetime(
        {
          ...validEnabledConfig(),
          issuedAt: "2026-07-19T00:06:00.000Z",
          expiresAt: "2026-07-20T00:00:00.000Z",
        },
        now,
      ).reasonCode,
    ).toBe("CONFIG_NOT_YET_VALID");
    expect(
      validateLifetime({ ...validEnabledConfig(), issuedAt: "bad-date" }, now).reasonCode,
    ).toBe("CONFIG_SCHEMA_INVALID");
    expect(
      validateLifetime(
        {
          ...validEnabledConfig(),
          issuedAt: "2026-07-20T00:00:00.000Z",
          expiresAt: "2026-07-19T00:00:00.000Z",
        },
        now,
      ).reasonCode,
    ).toBe("CONFIG_SCHEMA_INVALID");
  });

  it("returns controlled state-machine failures", () => {
    const runtime = { state: "active", reasonCode: "NONE" };
    expect(transition(runtime, "idle").ok).toBe(false);
    expect(transition(runtime, "active", "NOT_A_REASON").ok).toBe(true);
    expect(runtime.reasonCode).toBe("INTERNAL_ERROR");

    const fresh = createInitialRuntimeState();
    activateRuntime(fresh, fakeAdapter(), new Date("2026-07-19T00:00:00.000Z"));
    expect(fresh.initializedAt).toBe("2026-07-19T00:00:00.000Z");
  });

  it("exposes only safe unavailable-adapter behavior", () => {
    const adapter = createUnavailableAdapter();
    expect(adapter.name).toBe("unavailable");
    expect(adapter.initialize().ok).toBe(false);
    expect(adapter.setTrackingConsent().ok).toBe(false);
    expect(adapter.recordAction().ok).toBe(false);
    expect(adapter.recordError().ok).toBe(false);
    expect(adapter.startSessionReplay().ok).toBe(false);
    expect(adapter.stopSessionReplay().ok).toBe(false);
    expect(adapter.shutdown().ok).toBe(true);
    expect(adapter.getCapabilities()).toEqual({ telemetry: false, sessionReplay: false });
  });
});

describe("initialization coordination", () => {
  it("shares concurrent same-options initialization", async () => {
    let release;
    const fetchPromise = new Promise((resolve) => {
      release = () => resolve(jsonResponse(validDisabledConfig()));
    });
    globalThis.fetch = vi.fn(() => fetchPromise);

    const first = initializeObservability(options);
    const second = initializeObservability(options);
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toEqual(
      expect.objectContaining({ reasonCode: "CONFIG_DISABLED" }),
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns conflict for concurrent different options", async () => {
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          // Keep the first initialization in flight.
        }),
    );
    const first = initializeObservability(options);
    const second = await initializeObservability({ ...options, service: "company-api" });
    expect(second.reasonCode).toBe("INITIALIZATION_CONFLICT");
    await shutdownObservability();
    await first;
  });

  it("returns active same-options no-op and different-options conflict", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => fakeAdapter());
    await initializeObservability(options);

    const duplicate = await initializeObservability(options);
    const conflict = await initializeObservability({ ...options, service: "company-api" });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.state).toBe("active");
    expect(conflict.ok).toBe(false);
    expect(conflict.reasonCode).toBe("INITIALIZATION_CONFLICT");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when enabled config has no adapter", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    const result = await initializeObservability(options);
    expect(result.reasonCode).toBe("ADAPTER_UNAVAILABLE");
    expect(getObservabilityStatus().state).toBe("disabled");
  });

  it("falls back to schemaVersion when configVersion is absent", async () => {
    const config = validDisabledConfig();
    delete config.configVersion;
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(config)));
    const result = await initializeObservability(options);
    expect(result.status.configVersion).toBe("1.0.0");
  });

  it("degrades when adapter initialize throws and isolates shutdown throws", async () => {
    const adapter = fakeAdapter();
    adapter.initialize.mockImplementation(() => {
      throw new Error("adapter failed");
    });
    adapter.shutdown.mockImplementation(() => {
      throw new Error("shutdown failed");
    });
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(validEnabledConfig())));
    setAdapterFactoryForTests(() => adapter);

    const result = await initializeObservability(options);
    expect(result.reasonCode).toBe("ADAPTER_ERROR");
    expect(getObservabilityStatus().state).toBe("degraded");
    await expect(shutdownObservability()).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it("reports unsupported runtime without touching fetch", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    delete globalThis.window;
    delete globalThis.document;
    globalThis.fetch = vi.fn();
    try {
      const result = await initializeObservability(options);
      expect(result.reasonCode).toBe("UNSUPPORTED_RUNTIME");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    }
  });

  it("converts unexpected initialization errors to a controlled result", async () => {
    const OriginalAbortController = globalThis.AbortController;
    globalThis.AbortController = class BrokenAbortController {
      constructor() {
        throw new Error("no abort controller");
      }
    };
    try {
      const result = await initializeObservability(options);
      expect(result.reasonCode).toBe("INTERNAL_ERROR");
      expect(getObservabilityStatus().state).toBe("disabled");
    } finally {
      globalThis.AbortController = OriginalAbortController;
    }
  });

  it("covers registry access and invalid mid-flight options without payload state", async () => {
    expect(getExistingRuntimeRegistry()).toBeNull();
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          // Keep initialization in flight.
        }),
    );
    const first = initializeObservability(options);
    const invalid = await initializeObservability({ ...options, version: "" });
    expect(invalid.reasonCode).toBe("OPTIONS_INVALID");
    expect(getExistingRuntimeRegistry()).toMatchObject({
      lifecycleGeneration: 1,
      fingerprint: expect.any(String),
    });
    await shutdownObservability();
    await first;
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
    headers: jsonHeaders(),
  });
}

function jsonHeaders() {
  return { "content-type": "application/json" };
}
