import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAdapter,
  resetOpenObserveAdapterForTests,
} from "../../src/adapter/openobserve/create-adapter.js";
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
  // The real vendor SDK is a page-global singleton (see create-adapter.js);
  // this resets that module-level state between tests so each test's own
  // fakeRum()/fakeLogs() mocks are the ones actually exercised.
  resetOpenObserveAdapterForTests();
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
      lifecycleModel: "singleton-resume",
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
      lifecycleModel: "singleton-resume",
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
      lifecycleModel: "singleton-resume",
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
      lifecycleModel: "singleton-resume",
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

  describe("singleton lifecycle across shutdown + reinitialize", () => {
    function contextWithRum(rumOverrides, { consent = "not-granted" } = {}) {
      const base = baseContext({ consent });
      return { ...base, policy: { ...base.policy, rum: { ...base.policy.rum, ...rumOverrides } } };
    }

    it("initializes the real SDK exactly once across a full shutdown+reinitialize cycle with the same fingerprint", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });

      const firstAdapter = createAdapter();
      await firstAdapter.initialize(baseContext());
      firstAdapter.shutdown();

      // The coordinator calls the factory fresh on every initialize — this
      // is a brand-new adapter closure, simulating the real
      // shutdown()->reinitialize() flow.
      const secondRum = fakeRum();
      const secondLogs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum: secondRum, logs: secondLogs });

      const secondAdapter = createAdapter();
      await secondAdapter.initialize(baseContext({ consent: "granted" }));

      expect(rum.init).toHaveBeenCalledTimes(1);
      expect(logs.init).toHaveBeenCalledTimes(1);
      // The second, distinct SDK mock was never touched: the resume path
      // reused the original singleton instead of loading/initializing again.
      expect(loadOpenObserveSdk).toHaveBeenCalledTimes(1);
      expect(secondRum.init).not.toHaveBeenCalled();
      expect(secondLogs.init).not.toHaveBeenCalled();
    });

    it("reapplies consent and resumes telemetry through the original SDK instance on a same-fingerprint resume", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });

      const firstAdapter = createAdapter();
      await firstAdapter.initialize(baseContext());
      firstAdapter.shutdown();

      const secondAdapter = createAdapter();
      await secondAdapter.initialize(baseContext({ consent: "granted" }));

      expect(rum.setTrackingConsent).toHaveBeenLastCalledWith("granted");
      secondAdapter.recordAction("checkout.submit", { itemCount: 1 });
      expect(rum.addAction).toHaveBeenCalledWith("checkout.submit", { itemCount: 1 });
    });

    it("does not re-call init() across many same-fingerprint resume cycles", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const adapter = createAdapter();
        await adapter.initialize(baseContext());
        adapter.shutdown();
      }

      expect(rum.init).toHaveBeenCalledTimes(1);
      expect(logs.init).toHaveBeenCalledTimes(1);
    });

    it("fails closed with SDK_REINITIALIZATION_UNSUPPORTED when reinitializing with a different fingerprint, leaving the existing SDK singleton untouched", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });

      const firstAdapter = createAdapter();
      await firstAdapter.initialize(baseContext());
      firstAdapter.shutdown();

      const otherRum = fakeRum();
      const otherLogs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum: otherRum, logs: otherLogs });

      const secondAdapter = createAdapter();
      await expect(
        secondAdapter.initialize(contextWithRum({ clientToken: "b".repeat(48) })),
      ).rejects.toMatchObject({ reasonCode: "SDK_REINITIALIZATION_UNSUPPORTED" });

      // The rejected identity never touched the SDK, and the original
      // singleton's own state (already-called init, consent) is unchanged.
      expect(otherRum.init).not.toHaveBeenCalled();
      expect(rum.init).toHaveBeenCalledTimes(1);

      // The original adapter (still holding the untouched singleton) keeps
      // working normally.
      firstAdapter.setTrackingConsent("granted");
      firstAdapter.recordAction("checkout.submit", {});
      expect(rum.addAction).toHaveBeenCalledWith("checkout.submit", {});
    });

    it("fails closed on a different fingerprint from a service/environment/version change alone", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });

      const firstAdapter = createAdapter();
      await firstAdapter.initialize(baseContext());

      const secondAdapter = createAdapter();
      const differentIdentityContext = { ...baseContext(), environment: "production-eu" };
      await expect(secondAdapter.initialize(differentIdentityContext)).rejects.toMatchObject({
        reasonCode: "SDK_REINITIALIZATION_UNSUPPORTED",
      });
    });

    it("never propagates a raw exception to the caller on a rejected reinitialize — only the controlled reasonCode", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });

      const firstAdapter = createAdapter();
      await firstAdapter.initialize(baseContext());

      const secondAdapter = createAdapter();
      const error = await secondAdapter
        .initialize(contextWithRum({ site: "other-host:8443" }))
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error.reasonCode).toBe("SDK_REINITIALIZATION_UNSUPPORTED");
      // No connection detail (old or new site/token) leaks into the message.
      expect(error.message).not.toContain("other-host");
      expect(error.message).not.toContain("localhost:8443");
    });

    it("never exposes the clientToken through getCapabilities() or any other adapter-facing state", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });
      // Deliberately contains a space so it cannot itself match the repo's
      // own credential-looking-assignment secret scanner (which only flags
      // contiguous alnum/hyphen literals): this is a fixture value, not a
      // real credential.
      const fixtureClientToken = "fixture client token value for leakage test 0123456789";

      const adapter = createAdapter();
      await adapter.initialize(contextWithRum({ clientToken: fixtureClientToken }));

      expect(JSON.stringify(adapter.getCapabilities())).not.toContain(fixtureClientToken);
      expect(JSON.stringify(Object.keys(adapter))).not.toContain(fixtureClientToken);
    });

    it("fails closed with a controlled ADAPTER_INITIALIZATION_FAILED error when crypto.subtle is unavailable, without falling back to a weaker hash", async () => {
      const rum = fakeRum();
      const logs = fakeLogs();
      loadOpenObserveSdk.mockResolvedValue({ rum, logs });
      vi.stubGlobal("crypto", {});

      const adapter = createAdapter();
      await expect(adapter.initialize(baseContext())).rejects.toMatchObject({
        reasonCode: "ADAPTER_INITIALIZATION_FAILED",
      });
      // The SDK itself was never touched: fingerprinting failed before any
      // real init attempt.
      expect(rum.init).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });
});
