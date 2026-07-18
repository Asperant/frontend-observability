import {
  symlinkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  atomicWriteFile,
  fileMode,
  isWorldOrGroupReadableSecret,
  rejectSymlink,
} from "../../scripts/lab/common.mjs";

let scratchDir;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "chicek-lab-atomic-write-"));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("writes the file with the requested content and mode", () => {
    const target = join(scratchDir, "secret");
    atomicWriteFile(target, "hello", { mode: 0o600 });
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(fileMode(target)).toBe(0o600);
  });

  it("leaves no temp files behind after a successful write", () => {
    const target = join(scratchDir, "secret");
    atomicWriteFile(target, "hello", { mode: 0o600 });
    // Only the final file should exist in the scratch dir, no .tmp-* leftovers.
    expect(readdirSync(scratchDir)).toEqual(["secret"]);
  });

  it("overwrites an existing regular file", () => {
    const target = join(scratchDir, "secret");
    writeFileSync(target, "old");
    atomicWriteFile(target, "new", { mode: 0o600 });
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("refuses to write through a symlink", () => {
    const real = join(scratchDir, "real-target");
    const link = join(scratchDir, "link");
    writeFileSync(real, "original");
    symlinkSync(real, link);
    expect(() => atomicWriteFile(link, "malicious", { mode: 0o600 })).toThrow(/symlink/);
  });
});

describe("rejectSymlink", () => {
  it("does not throw for a path that does not exist yet", () => {
    expect(() => rejectSymlink(join(scratchDir, "does-not-exist"))).not.toThrow();
  });

  it("does not throw for a regular file", () => {
    const target = join(scratchDir, "regular");
    writeFileSync(target, "x");
    expect(() => rejectSymlink(target)).not.toThrow();
  });

  it("throws for a symlink", () => {
    const real = join(scratchDir, "real");
    const link = join(scratchDir, "link");
    writeFileSync(real, "x");
    symlinkSync(real, link);
    expect(() => rejectSymlink(link)).toThrow(/symlink/);
  });
});

describe("isWorldOrGroupReadableSecret", () => {
  it("flags a world-readable file", () => {
    const target = join(scratchDir, "loose");
    writeFileSync(target, "x", { mode: 0o644 });
    expect(isWorldOrGroupReadableSecret(target)).toBe(true);
  });

  it("does not flag an owner-only file", () => {
    const target = join(scratchDir, "tight");
    writeFileSync(target, "x", { mode: 0o600 });
    expect(isWorldOrGroupReadableSecret(target)).toBe(false);
  });
});
