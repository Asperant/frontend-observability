import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

describe("@frontend-observability/browser-observability package.json export map", () => {
  const pkg = readJson("../../packages/browser-observability/package.json");

  it("declares ESM-only 'module' type", () => {
    expect(pkg.type).toBe("module");
  });

  it("declares sideEffects: false", () => {
    expect(pkg.sideEffects).toBe(false);
  });

  it("exposes exactly one export map entry: '.'", () => {
    expect(Object.keys(pkg.exports)).toEqual(["."]);
  });

  it("points the '.' export only at dist/index.js and only via the import condition", () => {
    expect(pkg.exports["."]).toEqual({ import: "./dist/index.js" });
  });

  it("never declares a CommonJS 'require' export condition", () => {
    expect(JSON.stringify(pkg.exports)).not.toMatch(/"require"/);
  });

  it("depends on exactly the two pinned OpenObserve SDK packages, nothing else", () => {
    expect(pkg.dependencies).toEqual({
      "@openobserve/browser-logs": "0.3.4",
      "@openobserve/browser-rum": "0.3.4",
    });
  });

  it("pins exact SDK versions (no ^, ~, or dist-tag ranges)", () => {
    for (const version of Object.values(pkg.dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("@frontend-observability/observability-contracts package.json export map", () => {
  const pkg = readJson("../../packages/observability-contracts/package.json");

  it("exposes only the documented entry points", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [
        ".",
        "./schemas/custom-action",
        "./schemas/diagnostic-event",
        "./schemas/runtime-config",
      ].sort(),
    );
  });

  it("does not declare a wildcard/subpath export that would expose internals", () => {
    for (const key of Object.keys(pkg.exports)) {
      expect(key).not.toContain("*");
    }
  });
});
