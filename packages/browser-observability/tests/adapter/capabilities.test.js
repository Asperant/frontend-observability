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
    });
  });

  it("defaults sessionReplay to false", () => {
    expect(createCapabilities({ telemetry: true, logs: true })).toEqual({
      telemetry: true,
      logs: true,
      sessionReplay: false,
    });
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
    });
  });
});
