import { describe, expect, it } from "vitest";

import { validateRuntimeConfigShape } from "../src/config/load-config.js";

function config(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    enabled: true,
    issuedAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    killSwitch: { engaged: false },
    privacyProfile: "strict",
    sampling: { sessionSampleRate: 1 },
    rum: {
      site: "localhost:8443",
      organizationIdentifier: "default",
      applicationId: "app",
      clientToken: "a".repeat(48),
      apiVersion: "v1",
    },
    browserLogs: { enabled: true },
    sessionReplay: { enabled: false },
    sensitiveRoutes: [],
    ...overrides,
  };
}

// Mirrors packages/contracts/schemas/runtime-config.schema.json: this
// hand-rolled runtime validator has no Ajv/JSON-Schema dependency (kept out
// of the browser bundle), so its acceptance of the canonical field, the
// deprecated legacy alias, and the fail-closed both/neither cases is
// pinned here independently of the schema-level contract tests.
describe("validateRuntimeConfigShape — sensitiveRoutes / allowedRoutes", () => {
  it("accepts the canonical sensitiveRoutes field alone", () => {
    expect(validateRuntimeConfigShape(config({ sensitiveRoutes: ["/a"] }))).toBe(true);
  });

  it("accepts the deprecated legacy allowedRoutes field alone", () => {
    expect(
      validateRuntimeConfigShape(config({ sensitiveRoutes: undefined, allowedRoutes: ["/a"] })),
    ).toBe(true);
  });

  it("fails closed when both sensitiveRoutes and allowedRoutes are present", () => {
    expect(
      validateRuntimeConfigShape(config({ sensitiveRoutes: ["/a"], allowedRoutes: ["/a"] })),
    ).toBe(false);
  });

  it("fails closed when neither sensitiveRoutes nor allowedRoutes is present", () => {
    expect(validateRuntimeConfigShape(config({ sensitiveRoutes: undefined }))).toBe(false);
  });
});

describe("validateRuntimeConfigShape — deprecated no-op fields are optional", () => {
  it("accepts a config that omits allowedSelectors entirely", () => {
    expect(validateRuntimeConfigShape(config())).toBe(true);
  });

  it("still validates allowedSelectors shape when a legacy config sends it", () => {
    expect(validateRuntimeConfigShape(config({ allowedSelectors: ["#app"] }))).toBe(true);
    expect(validateRuntimeConfigShape(config({ allowedSelectors: [123] }))).toBe(false);
  });

  it("accepts a config that omits sampling.errorSampleRate entirely", () => {
    expect(validateRuntimeConfigShape(config({ sampling: { sessionSampleRate: 1 } }))).toBe(true);
  });

  it("still validates errorSampleRate range when a legacy config sends it", () => {
    expect(
      validateRuntimeConfigShape(
        config({ sampling: { sessionSampleRate: 1, errorSampleRate: 1 } }),
      ),
    ).toBe(true);
    expect(
      validateRuntimeConfigShape(
        config({ sampling: { sessionSampleRate: 1, errorSampleRate: 2 } }),
      ),
    ).toBe(false);
  });

  it("still accepts the deprecated balanced privacy profile", () => {
    expect(validateRuntimeConfigShape(config({ privacyProfile: "balanced" }))).toBe(true);
  });

  it("rejects a sampling object with an unknown key", () => {
    expect(
      validateRuntimeConfigShape(config({ sampling: { sessionSampleRate: 1, unexpectedKey: 1 } })),
    ).toBe(false);
  });
});
