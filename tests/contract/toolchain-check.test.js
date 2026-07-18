import { describe, expect, it } from "vitest";

import {
  checkExactNodeVersion,
  checkExactPnpmVersion,
  parseSemver,
} from "../../scripts/verify/toolchain.js";

describe("parseSemver", () => {
  it("parses a plain major.minor.patch string", () => {
    expect(parseSemver("24.18.0")).toEqual({
      major: "24",
      minor: "18",
      patch: "0",
      full: "24.18.0",
    });
  });

  it("parses a v-prefixed version (process.version style)", () => {
    expect(parseSemver("v24.18.0")).toEqual({
      major: "24",
      minor: "18",
      patch: "0",
      full: "24.18.0",
    });
  });

  it("returns null for garbage input", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
  });
});

describe("checkExactNodeVersion", () => {
  it("accepts an exact major.minor.patch match", () => {
    const result = checkExactNodeVersion("24.18.0", "v24.18.0");
    expect(result).toEqual({ ok: true, expected: "24.18.0", actual: "24.18.0" });
  });

  it("rejects the same major but a different patch version", () => {
    const result = checkExactNodeVersion("24.18.0", "v24.18.1");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected 24.18.0");
    expect(result.message).toContain("found 24.18.1");
  });

  it("rejects the same major but a different minor version", () => {
    const result = checkExactNodeVersion("24.18.0", "v24.13.0");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected 24.18.0");
    expect(result.message).toContain("found 24.13.0");
  });

  it("rejects a different major version", () => {
    const result = checkExactNodeVersion("24.18.0", "v22.18.0");
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid .node-version file content", () => {
    const result = checkExactNodeVersion("not-a-version", "v24.18.0");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid .node-version content");
  });

  it("rejects when the actual Node version cannot be parsed", () => {
    const result = checkExactNodeVersion("24.18.0", "garbage");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unable to parse");
  });
});

describe("checkExactPnpmVersion", () => {
  it("accepts an exact match against the packageManager field, ignoring the integrity suffix", () => {
    const result = checkExactPnpmVersion("pnpm@11.15.0+sha512.deadbeef", "11.15.0");
    expect(result).toEqual({ ok: true, expected: "11.15.0", actual: "11.15.0" });
  });

  it("rejects a different pnpm patch version", () => {
    const result = checkExactPnpmVersion("pnpm@11.15.0+sha512.deadbeef", "11.15.1");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected 11.15.0");
    expect(result.message).toContain("found 11.15.1");
  });

  it("rejects a different pnpm minor version", () => {
    const result = checkExactPnpmVersion("pnpm@11.15.0+sha512.deadbeef", "11.9.0");
    expect(result.ok).toBe(false);
  });

  it("rejects a missing packageManager field", () => {
    const result = checkExactPnpmVersion(undefined, "11.15.0");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("missing a pinned packageManager field");
  });

  it("rejects a malformed packageManager field", () => {
    const result = checkExactPnpmVersion("not-a-valid-field", "11.15.0");
    expect(result.ok).toBe(false);
  });
});
