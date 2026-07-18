import { beforeEach, describe, expect, it } from "vitest";

import { getObservabilityStatus, initializeObservability } from "../src/index.js";
import { resetState } from "../src/internal/state.js";

beforeEach(() => {
  resetState();
});

describe("getObservabilityStatus", () => {
  it("reports null applicationId/privacyProfile before initialization", () => {
    const status = getObservabilityStatus();
    expect(status.applicationId).toBeNull();
    expect(status.privacyProfile).toBeNull();
    expect(status.status).toBe("uninitialized");
  });

  it("reports the active config after initialization", () => {
    initializeObservability({ applicationId: "demo", privacyProfile: "balanced" });
    const status = getObservabilityStatus();
    expect(status.applicationId).toBe("demo");
    expect(status.privacyProfile).toBe("balanced");
    expect(status.status).toBe("ready");
  });

  it("returns a frozen, read-only snapshot", () => {
    const status = getObservabilityStatus();
    expect(Object.isFrozen(status)).toBe(true);
    // ES modules run in strict mode, so mutating a frozen object throws.
    expect(() => {
      status.status = "tampered";
    }).toThrow(TypeError);
    expect(getObservabilityStatus().status).not.toBe("tampered");
  });
});
