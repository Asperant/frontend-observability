// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  validateCustomAction,
  validateDiagnosticEvent,
  validateRuntimeConfig,
} from "../src/validators.js";

const fixturesRoot = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));

function loadFixture(relativePath) {
  return JSON.parse(readFileSync(`${fixturesRoot}${relativePath}`, "utf8"));
}

describe("validateRuntimeConfig", () => {
  it("accepts a valid strict-profile config", () => {
    const result = validateRuntimeConfig(loadFixture("runtime-config/valid-strict.json"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a valid balanced-profile config", () => {
    const result = validateRuntimeConfig(loadFixture("runtime-config/valid-balanced.json"));
    expect(result.valid).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    const result = validateRuntimeConfig(loadFixture("runtime-config/invalid-unknown-key.json"));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects insecure http:// RUM endpoints", () => {
    const result = validateRuntimeConfig(loadFixture("runtime-config/invalid-insecure-http.json"));
    expect(result.valid).toBe(false);
  });

  it("rejects arbitrary non-URL RUM endpoints", () => {
    const result = validateRuntimeConfig(loadFixture("runtime-config/invalid-arbitrary-url.json"));
    expect(result.valid).toBe(false);
  });

  it("rejects sessionReplay.enabled = true (privacy baseline)", () => {
    const result = validateRuntimeConfig(loadFixture("runtime-config/invalid-replay-enabled.json"));
    expect(result.valid).toBe(false);
  });

  it("rejects a privacy profile outside the closed enum (weakening attempt)", () => {
    const result = validateRuntimeConfig(
      loadFixture("runtime-config/invalid-privacy-profile-weakened.json"),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a config missing a required field", () => {
    const result = validateRuntimeConfig(
      loadFixture("runtime-config/invalid-missing-required.json"),
    );
    expect(result.valid).toBe(false);
  });

  it.each([null, undefined, 42, "string", [], () => {}])(
    "never throws for malformed input: %p",
    (input) => {
      expect(() => validateRuntimeConfig(input)).not.toThrow();
      expect(validateRuntimeConfig(input).valid).toBe(false);
    },
  );
});

describe("validateCustomAction", () => {
  it("accepts a well-formed action name and attributes", () => {
    const result = validateCustomAction(loadFixture("custom-action/valid.json"));
    expect(result.valid).toBe(true);
  });

  it("rejects action names with spaces or punctuation", () => {
    const result = validateCustomAction(loadFixture("custom-action/invalid-name.json"));
    expect(result.valid).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const result = validateCustomAction({
      schemaVersion: "1.0.0",
      name: "checkout.submit",
      unexpected: true,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects object-valued attributes (only primitives allowed)", () => {
    const result = validateCustomAction({
      schemaVersion: "1.0.0",
      name: "checkout.submit",
      attributes: { nested: { a: 1 } },
    });
    expect(result.valid).toBe(false);
  });
});

describe("validateDiagnosticEvent", () => {
  it("accepts a well-formed diagnostic event", () => {
    const result = validateDiagnosticEvent(loadFixture("diagnostic-event/valid.json"));
    expect(result.valid).toBe(true);
  });

  it("rejects a level outside the closed enum", () => {
    const result = validateDiagnosticEvent(loadFixture("diagnostic-event/invalid-level.json"));
    expect(result.valid).toBe(false);
  });
});
