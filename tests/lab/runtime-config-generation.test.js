import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateRuntimeConfig } from "../../packages/contracts/src/validators.js";
import { buildLabRuntimeConfig } from "../../scripts/lab/generate-runtime-config.mjs";
import { ensureSecrets } from "../../scripts/lab/generate-secrets.mjs";
import { generateRuntimeConfig } from "../../scripts/lab/generate-runtime-config.mjs";
import { runtimeConfigPath, rumClientTokenSecretPath } from "../../scripts/lab/common.mjs";

describe("buildLabRuntimeConfig", () => {
  it("produces a schema-valid, enabled config with a real RUM client token", () => {
    const config = buildLabRuntimeConfig(new Date("2026-07-19T00:00:00.000Z"), {
      rumClientToken: "a".repeat(48),
    });
    const result = validateRuntimeConfig(config);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(config.enabled).toBe(true);
    expect(config.sessionReplay.enabled).toBe(false);
    expect(config.browserLogs.enabled).toBe(true);
    expect(config.rum.clientToken).toBe("a".repeat(48));
    expect(config.killSwitch.engaged).toBe(false);
  });

  it("issuedAt is before expiresAt", () => {
    const config = buildLabRuntimeConfig(new Date("2026-07-19T00:00:00.000Z"), {
      rumClientToken: "a".repeat(48),
    });
    expect(new Date(config.issuedAt).getTime()).toBeLessThan(new Date(config.expiresAt).getTime());
  });
});

describe("generateRuntimeConfig", () => {
  it("atomically writes a schema-valid, enabled runtime config using the generated RUM secret", () => {
    ensureSecrets();
    generateRuntimeConfig();
    expect(existsSync(runtimeConfigPath)).toBe(true);
    const written = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
    expect(validateRuntimeConfig(written).valid).toBe(true);
    expect(written.enabled).toBe(true);
    expect(written.rum.clientToken).toBe(readFileSync(rumClientTokenSecretPath, "utf8").trim());
  });
});
