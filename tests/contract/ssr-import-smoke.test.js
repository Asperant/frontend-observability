import { describe, expect, it } from "vitest";

const packageSrcUrl = new URL("../../packages/browser-observability/src/index.js", import.meta.url);

describe("SSR/Node import smoke", () => {
  it("imports without browser globals and exports only the public API", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalNavigator = globalThis.navigator;
    const originalLocation = globalThis.location;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.navigator;
    delete globalThis.location;

    try {
      const mod = await import(`${packageSrcUrl.href}?ssr=${Date.now()}`);
      expect(Object.keys(mod).sort()).toEqual(
        [
          "getObservabilityStatus",
          "initializeObservability",
          "recordAction",
          "recordError",
          "setTrackingConsent",
          "shutdownObservability",
        ].sort(),
      );
      expect(mod.getObservabilityStatus().state).toBe("idle");
      const result = await mod.initializeObservability({
        service: "company-web",
        environment: "production",
        version: "2026.07.1",
      });
      expect(result.reasonCode).toBe("UNSUPPORTED_RUNTIME");
    } finally {
      if (originalWindow !== undefined) globalThis.window = originalWindow;
      if (originalDocument !== undefined) globalThis.document = originalDocument;
      if (originalNavigator !== undefined) {
        Object.defineProperty(globalThis, "navigator", {
          value: originalNavigator,
          configurable: true,
          writable: true,
        });
      }
      if (originalLocation !== undefined) globalThis.location = originalLocation;
    }
  });
});
