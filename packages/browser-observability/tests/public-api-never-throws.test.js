import { beforeEach, describe, expect, it } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  recordError,
  setTrackingConsent,
  shutdownObservability,
} from "../src/index.js";
import { resetRuntimeRegistryForTests } from "../src/bootstrap/runtime-registry.js";

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
  resetRuntimeRegistryForTests();
});

describe("public API never throws", () => {
  it("initializeObservability tolerates hostile input", async () => {
    for (const value of HOSTILE_VALUES) {
      await expect(initializeObservability(value)).resolves.toEqual(
        expect.objectContaining({ ok: false }),
      );
    }
  });

  it("setTrackingConsent tolerates hostile input", () => {
    for (const value of HOSTILE_VALUES) {
      expect(() => setTrackingConsent(value)).not.toThrow();
    }
  });

  it("recordAction tolerates hostile input", () => {
    for (const value of HOSTILE_VALUES) {
      expect(() => recordAction(value, value)).not.toThrow();
    }
  });

  it("recordError tolerates hostile input", () => {
    for (const value of HOSTILE_VALUES) {
      expect(() => recordError(value, value)).not.toThrow();
    }
  });

  it("getObservabilityStatus never throws and always returns a snapshot shape", () => {
    expect(() => getObservabilityStatus()).not.toThrow();
    const status = getObservabilityStatus();
    expect(status).toHaveProperty("state");
    expect(status).toHaveProperty("consent");
    expect(status).toHaveProperty("counters");
  });

  it("shutdownObservability never throws, initialized or not", async () => {
    await expect(shutdownObservability()).resolves.toEqual(expect.objectContaining({ ok: true }));
  });
});
