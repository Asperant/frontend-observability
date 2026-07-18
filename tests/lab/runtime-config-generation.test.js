import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateRuntimeConfig } from "../../packages/contracts/src/validators.js";
import {
  buildStage6RuntimeConfig,
  generateRuntimeConfig,
} from "../../scripts/lab/generate-runtime-config.mjs";
import { runtimeConfigPath } from "../../scripts/lab/common.mjs";

describe("buildStage6RuntimeConfig", () => {
  it("produces a schema-valid, fully-disabled config with no RUM credentials", () => {
    const config = buildStage6RuntimeConfig(new Date("2026-07-19T00:00:00.000Z"));
    const result = validateRuntimeConfig(config);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(config.enabled).toBe(false);
    expect(config.sessionReplay.enabled).toBe(false);
    expect(config.rum).toEqual({});
    expect(config.killSwitch.engaged).toBe(true);
  });

  it("issuedAt is before expiresAt", () => {
    const config = buildStage6RuntimeConfig(new Date("2026-07-19T00:00:00.000Z"));
    expect(new Date(config.issuedAt).getTime()).toBeLessThan(new Date(config.expiresAt).getTime());
  });
});

describe("generateRuntimeConfig", () => {
  it("atomically writes a schema-valid runtime config file with the correct mode", () => {
    generateRuntimeConfig();
    expect(existsSync(runtimeConfigPath)).toBe(true);
    const written = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
    expect(validateRuntimeConfig(written).valid).toBe(true);
  });
});
