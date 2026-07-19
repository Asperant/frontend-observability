import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG_URL,
  normalizeOptions,
  validateConfigUrl,
  validateOptions,
} from "../src/config/validate-options.js";

describe("validateOptions", () => {
  const valid = {
    service: "company-web",
    environment: "production",
    version: "2026.07.1",
  };

  it.each([null, undefined, "string", 42, ["array"]])(
    "rejects non-object options: %p",
    (options) => {
      expect(validateOptions(options).valid).toBe(false);
    },
  );

  it("defaults configUrl and normalizes identity", () => {
    expect(validateOptions(valid).valid).toBe(true);
    expect(normalizeOptions(valid)).toEqual({
      configUrl: DEFAULT_CONFIG_URL,
      service: "company-web",
      environment: "production",
      version: "2026.07.1",
    });
  });

  it.each([
    [{ ...valid, service: "a" }],
    [{ ...valid, service: "Company-Web" }],
    [{ ...valid, service: "company_web" }],
    [{ ...valid, service: "company web" }],
    [{ ...valid, service: "team@example.com" }],
    [{ ...valid, service: "550e8400-e29b-41d4-a716-446655440000" }],
    [{ ...valid, service: "-company-web" }],
    [{ ...valid, service: "company-web-" }],
    [{ ...valid, environment: "prod" }],
    [{ ...valid, version: "" }],
    [{ ...valid, version: "x".repeat(65) }],
    [{ ...valid, extra: true }],
  ])("rejects invalid options: %p", (options) => {
    expect(validateOptions(options).valid).toBe(false);
  });

  it.each(["user-portal", "account-management", "tenant-admin", "session-replay"])(
    "accepts legitimate service name: %s",
    (service) => {
      expect(validateOptions({ ...valid, service }).valid).toBe(true);
    },
  );

  it("includes configUrl validation errors in option validation", () => {
    const result = validateOptions({ ...valid, configUrl: "/observability/config.json?x=1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes("configUrl"))).toBe(true);
  });

  it("keeps absolute URLs in defensive normalization when origin differs", () => {
    expect(
      normalizeOptions({ ...valid, configUrl: "https://evil.example/config.json" }).configUrl,
    ).toBe("https://evil.example/config.json");
  });
});

describe("validateConfigUrl", () => {
  it.each(["/observability/config.json", "observability/config.json"])(
    "accepts relative URL: %s",
    (configUrl) => {
      expect(validateConfigUrl(configUrl).valid).toBe(true);
    },
  );

  it("accepts same-origin absolute URLs", () => {
    expect(
      validateConfigUrl(`${globalThis.window.location.origin}/observability/config.json`).valid,
    ).toBe(true);
  });

  it.each([
    "",
    undefined,
    "http://[",
    "https://evil.example/config.json",
    "/observability/config.json?x=1",
    "/observability/config.json#x",
    "javascript:alert(1)",
    "data:application/json,{}",
    "file:///tmp/config.json",
    `/observability/${"x".repeat(260)}.json`,
  ])("rejects unsafe configUrl: %s", (configUrl) => {
    expect(validateConfigUrl(configUrl).valid).toBe(false);
  });
});
