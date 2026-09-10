import { describe, expect, it } from "vitest";

const packageSrcUrl = new URL("../../packages/browser-observability/src/index.js", import.meta.url);

const EXPECTED_EXPORTS = [
  "getObservabilityStatus",
  "initializeObservability",
  "recordAction",
  "recordError",
  "setTrackingConsent",
  "shutdownObservability",
].sort();

const FORBIDDEN_EXPORT_NAMES = [
  "sendRawEvent",
  "sendPayload",
  "getRumSdk",
  "getLogsSdk",
  "getState",
  "resetState",
  "internal",
];

describe("@frontend-observability/browser-observability public API surface (source-level)", () => {
  it("exports exactly the approved public functions, nothing more and nothing less", async () => {
    const mod = await import(packageSrcUrl.href);
    expect(Object.keys(mod).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it("does not export raw-SDK or internal-state helpers", async () => {
    const mod = await import(packageSrcUrl.href);
    for (const forbiddenName of FORBIDDEN_EXPORT_NAMES) {
      expect(mod).not.toHaveProperty(forbiddenName);
    }
  });

  it("every exported member is a callable function", async () => {
    const mod = await import(packageSrcUrl.href);
    for (const [name, value] of Object.entries(mod)) {
      expect(typeof value, `expected export "${name}" to be a function`).toBe("function");
    }
  });
});
