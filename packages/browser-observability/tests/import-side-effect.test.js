import { describe, expect, it } from "vitest";

import { getObservabilityStatus } from "../src/index.js";

describe("import side effects", () => {
  it("does not auto-initialize when the package is imported", () => {
    const status = getObservabilityStatus();
    expect(status.state).toBe("idle");
    expect(status.service).toBeNull();
    expect(status.consent).toBe("not-granted");
  });

  it("does not attach anything to the global scope", () => {
    expect(globalThis.frontendObservability).toBeUndefined();
    expect(globalThis.__FRONTEND_OBSERVABILITY__).toBeUndefined();
  });
});
