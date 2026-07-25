import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildManifest, manifestFileName } from "../../scripts/build/generate-artifact-manifest.js";

describe("browser package artifact manifest is reproducible", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artifact-manifest-test-"));
    writeFileSync(join(dir, "zeta.js"), "console.log('zeta');\n");
    writeFileSync(join(dir, "alpha.js"), "console.log('alpha');\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces byte-identical JSON across two independent calls with the same inputs", () => {
    const first = JSON.stringify(buildManifest(dir));
    const second = JSON.stringify(buildManifest(dir));
    expect(first).toBe(second);
  });

  it("never includes a wall-clock timestamp or other run-specific field", () => {
    const manifest = buildManifest(dir);
    expect(manifest).not.toHaveProperty("generatedAt");
    const serialized = JSON.stringify(manifest);
    // No ISO-8601-shaped timestamp anywhere in the output.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("sorts the output file list alphabetically regardless of directory read order", () => {
    const manifest = buildManifest(dir);
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(["alpha.js", "zeta.js"]);
  });

  it("excludes the manifest file itself from the file list", () => {
    writeFileSync(join(dir, manifestFileName), "{}");
    const manifest = buildManifest(dir);
    expect(manifest.files.map((file) => file.path)).not.toContain(manifestFileName);
  });

  it("recomputes a different hash when file content changes, proving hashes are content-derived", () => {
    const before = buildManifest(dir);
    writeFileSync(join(dir, "alpha.js"), "console.log('changed');\n");
    const after = buildManifest(dir);
    const beforeHash = before.files.find((file) => file.path === "alpha.js").sha256;
    const afterHash = after.files.find((file) => file.path === "alpha.js").sha256;
    expect(afterHash).not.toBe(beforeHash);
  });
});
