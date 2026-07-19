import { describe, expect, it } from "vitest";

import { checkExactLabToolchain } from "../../scripts/lab/common.mjs";

const validDependencies = Object.freeze({
  expectedNodeVersion: "24.18.0",
  packageManager: "pnpm@11.15.0+sha512.deadbeef",
  actualNodeVersion: "v24.18.0",
  actualPnpmVersion: "11.15.0",
});

describe("lab exact toolchain guard", () => {
  it.each(["lab:init", "lab:up", "lab:verify"])(
    "fails %s before work starts on a wrong Node patch version",
    (commandName) => {
      const result = checkExactLabToolchain(commandName, {
        ...validDependencies,
        actualNodeVersion: "v24.18.1",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain(commandName);
      expect(result.message).toContain("expected 24.18.0");
      expect(result.message).toContain("found 24.18.1");
    },
  );

  it("passes with the exact Node and pnpm versions", () => {
    expect(checkExactLabToolchain("lab:init", validDependencies)).toEqual({
      ok: true,
      node: "24.18.0",
      pnpm: "11.15.0",
    });
  });

  it("fails on a wrong pnpm patch version", () => {
    const result = checkExactLabToolchain("lab:verify", {
      ...validDependencies,
      actualPnpmVersion: "11.15.1",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("pnpm version mismatch");
  });
});
