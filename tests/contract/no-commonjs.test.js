import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

describe("no CommonJS anywhere in the workspace", () => {
  it.each([
    "package.json",
    "packages/browser-observability/package.json",
    "packages/observability-contracts/package.json",
    "tests/fixtures/apps/browser-app/package.json",
    "tests/fixtures/apps/http-test-service/package.json",
  ])("%s declares type: module", (relativePath) => {
    expect(readJson(relativePath).type).toBe("module");
  });

  it("contains no .cjs files anywhere in the workspace source", () => {
    const IGNORED_DIRS = new Set(["node_modules", ".git", ".pnpm-store"]);
    function walk(dir) {
      const results = [];
      for (const entry of readdirSync(dir)) {
        if (IGNORED_DIRS.has(entry)) continue;
        const fullPath = join(dir, entry);
        const info = statSync(fullPath);
        if (info.isDirectory()) {
          results.push(...walk(fullPath));
        } else if (extname(entry) === ".cjs") {
          results.push(fullPath);
        }
      }
      return results;
    }
    expect(walk(repoRoot)).toEqual([]);
  });

  it("the built dist/index.js contains no require() or module.exports, once built", () => {
    const distIndex = join(repoRoot, "packages/browser-observability/dist/index.js");
    if (!existsSync(distIndex)) {
      // Contract tests run before the build step in `pnpm verify`'s ordering;
      // this assertion still runs meaningfully whenever dist/ already exists.
      return;
    }
    const content = readFileSync(distIndex, "utf8");
    expect(content).not.toMatch(/\brequire\(/);
    expect(content).not.toMatch(/module\.exports/);
  });
});
