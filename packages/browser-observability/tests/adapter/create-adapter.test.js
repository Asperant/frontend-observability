import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdapter } from "../../src/adapter/openobserve/create-adapter.js";
import { loadOpenObserveSdk } from "../../src/adapter/openobserve/load-sdk.js";

vi.mock("../../src/adapter/openobserve/load-sdk.js", () => ({
  loadOpenObserveSdk: vi.fn(),
}));

function fakeRum() {
  return {
    init: vi.fn(),
    setTrackingConsent: vi.fn(),
    addAction: vi.fn(),
    addError: vi.fn(),
    stopSessionReplayRecording: vi.fn(),
    startSessionReplayRecording: vi.fn(),
    stopSession: vi.fn(),
  };
}

function fakeLogs() {
  return {
    init: vi.fn(),
    setTrackingConsent: vi.fn(),
    logger: { log: vi.fn(), error: vi.fn() },
  };
}

const identity = Object.freeze({
  service: "demo-frontend",
  environment: "production",
  version: "1.0.0",
});

function baseContext({ consent = "not-granted", browserLogsEnabled = true } = {}) {
  return {
    ...identity,
    consent,
    policy: {
      rum: {
        site: "localhost:8443",
        organizationIdentifier: "default",
        applicationId: "app",
        clientToken: "a".repeat(48),
        apiVersion: "v1",
      },
      sampling: { sessionSampleRate: 1, errorSampleRate: 1 },
      browserLogs: { enabled: browserLogsEnabled },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAdapter", () => {
  it("exposes only the 8 adapter-contract methods plus name — no raw SDK reference", () => {
    const adapter = createAdapter();
    expect(Object.keys(adapter).sort()).toEqual(
      [
        "name",
        "initialize",
        "setTrackingConsent",
        "recordAction",
        "recordError",
        "startSessionReplay",
        "stopSessionReplay",
        "shutdown",
        "getCapabilities",
      ].sort(),
    );
    expect(adapter.name).toBe("openobserve");
    expect(Object.isFrozen(adapter)).toBe(true);
  });

  it("reports unavailable capabilities before initialize() is called", () => {
    const adapter = createAdapter();
    expect(adapter.getCapabilities()).toEqual({
      telemetry: false,
      logs: false,
      sessionReplay: false,
    });
  });

  it("initializes RUM and Logs, reporting both capabilities available", async () => {
    const rum = fakeRum();
    const logs = fakeLogs();
    loadOpenObserveSdk.mockResolvedValue({ rum, logs });

    const adapter = createAdapter();
    await adapter.initialize(baseContext());

    expect(rum.init).toHaveBeenCalledTimes(1);
    expect(logs.init).toHaveBeenCalledTimes(1);
    expect(adapter.getCapabilities()).toEqual({
      telemetry: true,
      logs: true,
      sessionReplay: false,
    });
  });

  it("does not attempt Logs init when the runtime config does not request it", async () => {
    const rum = fakeRum();
    const logs = fakeLogs();
    loadOpenObserveSdk.mockResolvedValue({ rum, logs });

    const adapter = createAdapter();
    await adapter.initialize(baseContext({ browserLogsEnabled: false }));

    expect(logs.init).not.toHaveBeenCalled();
    // Not attempted is not a failure: capabilities.logs stays true.
    expect(adapter.getCapabilities()).toEqual({
      telemetry: true,
      logs: true,
      sessionReplay: false,
    });
  });

  it("degrades logs capability (without failing the whole adapter) when Logs init throws", async () => {
    const rum = fakeRum();
    const logs = fakeLogs();
    logs.init.mockImplementation(() => {
      throw new Error("logs boom");
    });
    loadOpenObserveSdk.mockResolvedValue({ rum, logs });

    const adapter = createAdapter();
    await adapter.initialize(baseContext());

    expect(adapter.getCapabilities()).toEqual({
      telemetry: true,
      logs: false,
      sessionReplay: false,
    });
  });

  it("throws a controlled ADAPTER_INITIALIZATION_FAILED error when RUM init throws", async () => {
    const rum = fakeRum();
    rum.init.mockImplementation(() => {
      throw new Error("rum boom, includes secret token XYZ");
    });
    loadOpenObserveSdk.mockResolvedValue({ rum, logs: fakeLogs() });

    const adapter = createAdapter();
    await expect(adapter.initialize(baseContext())).rejects.toMatchObject({
      reasonCode: "ADAPTER_INITIALIZATION_FAILED",
    });
    // The vendor SDK's own exception message/detail is never carried through.
    await adapter.initialize(baseContext()).catch((error) => {
      expect(error.message).not.toContain("XYZ");
    });
  });

  it("throws the same controlled error when the dynamic import itself fails", async () => {
    loadOpenObserveSdk.mockRejectedValue(new Error("network error loading chunk"));

    const adapter = createAdapter();
    await expect(adapter.initialize(baseContext())).rejects.toMatchObject({
      reasonCode: "ADAPTER_INITIALIZATION_FAILED",
    });
  });

  it("applies the current consent right after init (matters after a shutdown+reinitialize cycle)", async () => {
    const rum = fakeRum();
    const logs = fakeLogs();
    loadOpenObserveSdk.mockResolvedValue({ rum, logs });

    const adapter = createAdapter();
    await adapter.initialize(baseContext({ consent: "granted" }));

    expect(rum.setTrackingConsent).toHaveBeenCalledWith("granted");
    expect(logs.setTrackingConsent).toHaveBeenCalledWith("granted");
    // First grant fires the browser-log canary exactly once.
    expect(logs.logger.log).toHaveBeenCalledTimes(1);
    expect(logs.logger.log).toHaveBeenCalledWith(
      "stage8.browser_logs.canary",
      { component: "demo-fixture", outcome: "success" },
      "info",
    );
  });

  it("initializes the SDK itself with trackingConsent not-granted even if context.consent is granted", async () => {
    const rum = fakeRum();
    const logs = fakeLogs();
    loadOpenObserveSdk.mockResolvedValue({ rum, logs });

    const adapter = createAdapter();
    await adapter.initialize(baseContext({ consent: "granted" }));

    expect(rum.init).toHaveBeenCalledWith(
      expect.objectContaining({ trackingConsent: "not-granted" }),
    );
    expect(logs.init).toHaveBeenCalledWith(
      expect.objectContaining({ trackingConsent: "not-granted" }),
    );
  });

  describe("after a successful initialize()", () => {
    let adapter;
    let rum;
    let logs;

    beforeEach(async () => {
      rum = fakeRum();
      logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });
      adapter = createAdapter();
      await adapter.initialize(baseContext());
    });

    it("setTrackingConsent maps and forwards to both channels, firing the canary only once", () => {
      adapter.setTrackingConsent("granted");
      adapter.setTrackingConsent("granted");
      expect(rum.setTrackingConsent).toHaveBeenCalledWith("granted");
      expect(logs.setTrackingConsent).toHaveBeenCalledWith("granted");
      expect(logs.logger.log).toHaveBeenCalledTimes(1);

      adapter.setTrackingConsent("not-granted");
      expect(rum.setTrackingConsent).toHaveBeenLastCalledWith("not-granted");
    });

    it("recordAction forwards the mapped name/context to rum.addAction", () => {
      const result = adapter.recordAction("checkout.submit", { itemCount: 2 });
      expect(rum.addAction).toHaveBeenCalledWith("checkout.submit", { itemCount: 2 });
      expect(result).toEqual({ ok: true });
    });

    it("recordError prefers rum.addError over the logs fallback", () => {
      const error = new Error("boom");
      adapter.recordError(error, { screen: "checkout" });
      expect(rum.addError).toHaveBeenCalledWith(error, { screen: "checkout" });
      expect(logs.logger.error).not.toHaveBeenCalled();
    });

    it("startSessionReplay never actually starts replay", () => {
      const result = adapter.startSessionReplay();
      expect(result).toEqual({ ok: false });
      expect(rum.startSessionReplayRecording).not.toHaveBeenCalled();
    });

    it("stopSessionReplay calls the real SDK method and always reports ok", () => {
      const result = adapter.stopSessionReplay();
      expect(rum.stopSessionReplayRecording).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
    });

    it("shutdown revokes consent on both channels and ends the session", () => {
      const result = adapter.shutdown();
      expect(rum.setTrackingConsent).toHaveBeenCalledWith("not-granted");
      expect(logs.setTrackingConsent).toHaveBeenCalledWith("not-granted");
      expect(rum.stopSession).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
    });
  });

  describe("recordError fallback when RUM is unavailable but Logs is not", () => {
    it("uses logger.error instead — never both channels for the same error", async () => {
      const logs = fakeLogs();
      const rum = fakeRum();
      rum.init.mockImplementation(() => {
        throw new Error("rum boom");
      });
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });

      const adapter = createAdapter();
      await adapter.initialize(baseContext()).catch(() => {});

      // RUM never came up, so recordAction/recordError have nothing to use.
      expect(adapter.recordAction("checkout.submit", {})).toEqual({ ok: false });
      expect(adapter.recordError(new Error("boom"), {})).toEqual({ ok: false });
    });
  });

  it("recordAction/recordError report ok:false when never initialized", () => {
    const adapter = createAdapter();
    expect(adapter.recordAction("checkout.submit", {})).toEqual({ ok: false });
    expect(adapter.recordError(new Error("boom"), {})).toEqual({ ok: false });
  });
});
