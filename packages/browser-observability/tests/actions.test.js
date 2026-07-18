import { beforeEach, describe, expect, it } from "vitest";

import { isValidActionName } from "../src/actions/validate-action-name.js";
import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  setTrackingConsent,
} from "../src/index.js";
import { resetState } from "../src/internal/state.js";

beforeEach(() => {
  resetState();
});

describe("custom action naming rules", () => {
  it.each(["checkout.submit", "click", "form_field_focus", "a.b.c"])(
    "accepts a well-formed name: %s",
    (name) => {
      expect(isValidActionName(name)).toBe(true);
    },
  );

  it.each([
    "",
    "Checkout.Submit",
    "checkout submit",
    "checkout!submit",
    "1checkout",
    ".checkout",
    "checkout.",
    "a".repeat(65),
    null,
    undefined,
    42,
  ])("rejects a malformed name: %p", (name) => {
    expect(isValidActionName(name)).toBe(false);
  });
});

describe("recordAction lifecycle", () => {
  it("is a no-op before initialization", () => {
    const result = recordAction("checkout.submit", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_ready");
  });

  it("is a no-op without granted consent", () => {
    initializeObservability({ applicationId: "demo" });
    const result = recordAction("checkout.submit", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("consent_not_granted");
  });

  it("rejects an invalid action name once ready and consented", () => {
    initializeObservability({ applicationId: "demo" });
    setTrackingConsent("granted");
    const result = recordAction("Not Valid!", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_action_name");
  });

  it("records a valid action once ready and consented", () => {
    initializeObservability({ applicationId: "demo" });
    setTrackingConsent("granted");
    const before = getObservabilityStatus().diagnosticsCount;
    const result = recordAction("checkout.submit", { itemCount: 3 });
    expect(result.ok).toBe(true);
    expect(getObservabilityStatus().diagnosticsCount).toBe(before + 1);
  });
});
