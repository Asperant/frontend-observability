import { beforeEach, describe, expect, it } from "vitest";

import {
  getObservabilityStatus,
  initializeObservability,
  shutdownObservability,
} from "../src/index.js";
import { getState, resetState } from "../src/internal/state.js";
import { STATUS } from "../src/internal/constants.js";

beforeEach(() => {
  resetState();
});

describe("status lifecycle", () => {
  it("moves uninitialized -> ready -> shutdown", () => {
    expect(getObservabilityStatus().status).toBe("uninitialized");

    const initResult = initializeObservability({ applicationId: "demo" });
    expect(initResult.ok).toBe(true);
    expect(getObservabilityStatus().status).toBe("ready");

    const shutdownResult = shutdownObservability();
    expect(shutdownResult.ok).toBe(true);
    expect(getObservabilityStatus().status).toBe("shutdown");
  });

  it("allows re-initialization after a shutdown", () => {
    initializeObservability({ applicationId: "demo" });
    shutdownObservability();

    const result = initializeObservability({ applicationId: "demo-again" });
    expect(result.ok).toBe(true);
    expect(getObservabilityStatus().applicationId).toBe("demo-again");
  });
});

describe("duplicate initialization", () => {
  it("rejects a second initializeObservability() call while ready", () => {
    initializeObservability({ applicationId: "demo" });
    const second = initializeObservability({ applicationId: "demo-2" });

    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_initialized");
    expect(getObservabilityStatus().applicationId).toBe("demo");
  });

  it("rejects initialization while status is mid-flight (initializing)", () => {
    getState().status = STATUS.INITIALIZING;

    const result = initializeObservability({ applicationId: "demo" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already_initialized");
  });
});

describe("shutdown edge cases", () => {
  it("is a controlled no-op when called before initialization", () => {
    const result = shutdownObservability();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_initialized");
  });

  it("is a controlled no-op when called twice in a row", () => {
    initializeObservability({ applicationId: "demo" });
    shutdownObservability();
    const second = shutdownObservability();

    expect(second.ok).toBe(false);
    expect(second.reason).toBe("not_initialized");
  });
});
