import { describe, expect, it } from "vitest";

import {
  createCapabilities,
  UNAVAILABLE_CAPABILITIES,
} from "../../src/adapter/openobserve/capabilities.js";

describe("createCapabilities", () => {
  it("coerces every field to a boolean", () => {
    expect(createCapabilities({ telemetry: 1, logs: 0, sessionReplay: "yes" })).toEqual({
      telemetry: true,
      logs: false,
      sessionReplay: true,
      lifecycleModel: "singleton-resume",
    });
  });

  it("defaults sessionReplay to false", () => {
    expect(createCapabilities({ telemetry: true, logs: true })).toEqual({
      telemetry: true,
      logs: true,
      sessionReplay: false,
      lifecycleModel: "singleton-resume",
    });
  });

  it("always reports the singleton-resume lifecycle model (a fixed adapter property, not per-call state)", () => {
    expect(createCapabilities({ telemetry: false, logs: false }).lifecycleModel).toBe(
      "singleton-resume",
    );
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(createCapabilities({ telemetry: true, logs: true }))).toBe(true);
  });
});

describe("UNAVAILABLE_CAPABILITIES", () => {
  it("reports everything as unavailable", () => {
    expect(UNAVAILABLE_CAPABILITIES).toEqual({
      telemetry: false,
      logs: false,
      sessionReplay: false,
      lifecycleModel: "singleton-resume",
    });
  });
});
