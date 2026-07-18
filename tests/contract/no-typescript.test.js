import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  "blob-report",
  ".pnpm-store",
]);

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      results.push(...walk(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

describe("no TypeScript anywhere in the repository", () => {
  const files = walk(repoRoot);

  it("contains no .ts or .tsx source files", () => {
    const tsFiles = files.filter((file) => [".ts", ".tsx"].includes(extname(file)));
    expect(tsFiles).toEqual([]);
  });

  it("contains no .d.ts declaration files", () => {
    const dtsFiles = files.filter((file) => file.endsWith(".d.ts"));
    expect(dtsFiles).toEqual([]);
  });

  it("contains no tsconfig*.json files", () => {
    const tsconfigFiles = files.filter((file) => /^tsconfig.*\.json$/.test(file.split("/").pop()));
    expect(tsconfigFiles).toEqual([]);
  });
});
