import { describe, expect, it } from "vitest";

import { run } from "../../scripts/lab/common.mjs";

describe("run() lab command failure handling", () => {
  it("throws with a descriptive message when allowFailure is false and the command fails", () => {
    expect(() => run("node", ["-e", "process.exit(3)"], { allowFailure: false })).toThrow(/exit 3/);
  });

  it("does not throw when allowFailure is true (the default) and reports the exit status", () => {
    const result = run("node", ["-e", "process.exit(7)"], { capture: true });
    expect(result.status).toBe(7);
  });

  it("propagates stdout/stderr in the thrown error for a failing captured command", () => {
    expect(() =>
      run("node", ["-e", "console.error('boom'); process.exit(1)"], {
        capture: true,
        allowFailure: false,
      }),
    ).toThrow(/boom/);
  });
});
