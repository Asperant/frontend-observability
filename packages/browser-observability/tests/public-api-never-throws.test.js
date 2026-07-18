import { beforeEach, describe, expect, it } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  recordError,
  setTrackingConsent,
  shutdownObservability,
} from "../src/index.js";
import { resetState } from "../src/internal/state.js";

const HOSTILE_VALUES = [
  undefined,
  null,
  42,
  "string",
  true,
  Symbol("x"),
  () => {},
  [1, 2, 3],
  {
    toString: () => {
      throw new Error("hostile toString");
    },
  },
];

beforeEach(() => {
  resetState();
});

describe("public API never throws", () => {
  it("initializeObservability tolerates hostile input", () => {
    for (const value of HOSTILE_VALUES) {
      expect(() => initializeObservability(value)).not.toThrow();
    }
  });

  it("setTrackingConsent tolerates hostile input", () => {
    for (const value of HOSTILE_VALUES) {
      expect(() => setTrackingConsent(value)).not.toThrow();
    }
  });

  it("recordAction tolerates hostile input", () => {
    initializeObservability({ applicationId: "demo" });
    setTrackingConsent("granted");
    for (const value of HOSTILE_VALUES) {
      expect(() => recordAction(value, value)).not.toThrow();
    }
  });

  it("recordError tolerates hostile input", () => {
    initializeObservability({ applicationId: "demo" });
    setTrackingConsent("granted");
    for (const value of HOSTILE_VALUES) {
      expect(() => recordError(value, value)).not.toThrow();
    }
  });

  it("getObservabilityStatus never throws and always returns a snapshot shape", () => {
    expect(() => getObservabilityStatus()).not.toThrow();
    const status = getObservabilityStatus();
    expect(status).toHaveProperty("status");
    expect(status).toHaveProperty("consent");
  });

  it("shutdownObservability never throws, initialized or not", () => {
    expect(() => shutdownObservability()).not.toThrow();
    initializeObservability({ applicationId: "demo" });
    expect(() => shutdownObservability()).not.toThrow();
  });
});
