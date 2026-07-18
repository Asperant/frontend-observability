import { describe, expect, it } from "vitest";

import { labPurge } from "../../scripts/lab/purge.mjs";

describe("labPurge confirmation gate", () => {
  it("refuses to purge without --yes and without an interactive TTY (no docker/filesystem side effects)", async () => {
    // vitest's stdin is not a TTY, so labPurge({}) must short-circuit to a
    // refusal without ever touching docker or the filesystem.
    const result = await labPurge({ yes: false });
    expect(result).toEqual({ purged: false });
  });
});
