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

// Mirrors packages/observability-contracts/schemas/runtime-config.schema.json: this
// hand-rolled runtime validator has no Ajv/JSON-Schema dependency (kept out
// of the browser bundle), so closed product config fields are pinned here
// independently of the schema-level contract tests.
describe("validateRuntimeConfigShape — sensitiveRoutes", () => {
  it("accepts the canonical sensitiveRoutes field alone", () => {
    expect(validateRuntimeConfigShape(config({ sensitiveRoutes: ["/a"] }))).toBe(true);
  });

  it("rejects the removed legacy allowedRoutes field", () => {
    expect(validateRuntimeConfigShape(config({ allowedRoutes: ["/a"] }))).toBe(false);
  });

  it("fails closed when sensitiveRoutes is missing", () => {
    expect(validateRuntimeConfigShape(config({ sensitiveRoutes: undefined }))).toBe(false);
  });
});

describe("validateRuntimeConfigShape — removed legacy fields", () => {
  it("accepts sessionSampleRate as the only sampling field", () => {
    expect(validateRuntimeConfigShape(config({ sampling: { sessionSampleRate: 1 } }))).toBe(true);
  });

  it("rejects sampling.errorSampleRate", () => {
    expect(
      validateRuntimeConfigShape(
        config({ sampling: { sessionSampleRate: 1, errorSampleRate: 1 } }),
      ),
    ).toBe(false);
  });

  it("rejects the removed balanced privacy profile", () => {
    expect(validateRuntimeConfigShape(config({ privacyProfile: "balanced" }))).toBe(false);
  });

  it("rejects a sampling object with an unknown key", () => {
    expect(
      validateRuntimeConfigShape(config({ sampling: { sessionSampleRate: 1, unexpectedKey: 1 } })),
    ).toBe(false);
  });
});
