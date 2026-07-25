import { describe, expect, it } from "vitest";

import { ReasonCodes } from "../src/diagnostics/reason-codes.js";
import { createCounters } from "../src/diagnostics/counters.js";
import { sanitizeAction } from "../src/sanitization/sanitizers/action.js";
import { sanitizeAttributes } from "../src/sanitization/sanitizers/attributes.js";
import { sanitizeError } from "../src/sanitization/sanitizers/error.js";
import { sanitizeLogEvent, sanitizeRumEvent } from "../src/sanitization/sanitizers/events.js";
import { sanitizeString } from "../src/sanitization/sanitizers/string.js";
import { sanitizeUrl } from "../src/sanitization/sanitizers/url.js";

describe("telemetry sanitizer baseline", () => {
  it("removes query, fragment and user-info while normalizing identifiers", () => {
    const userInfoUrl =
      "https://" +
      "user:pass@" +
      "example.invalid/users/12345678901234567890/123e4567-e89b-12d3-a456-426614174000?email=alice.test@example.invalid#secret";
    const result = sanitizeUrl(userInfoUrl, { baseUrl: "https://app.example.invalid/" });
    expect(result.decision).toBe("redact");
    expect(result.value).toBe("https://example.invalid/users/:id/:uuid");
    expect(result.reasons).toContain(ReasonCodes.PII_REDACTED);
  });

  it("redacts sensitive default routes", () => {
    const result = sanitizeUrl("/checkout/card?number=4111111111111111", {
      baseUrl: "https://app.example.invalid/",
    });
    expect(result.decision).toBe("redact");
    expect(result.value).toBe("/__sensitive__");
  });

  it("drops forbidden schemes and observability resources", () => {
    expect(sanitizeUrl("javascript:alert(1)").decision).toBe("drop");
    expect(
      sanitizeUrl("/rum/v1/default/rum", {
        baseUrl: "https://app.example.invalid/",
        resource: true,
      }).decision,
    ).toBe("drop");
  });

  it("redacts generic PII and drops secrets in strings", () => {
    expect(sanitizeString("email alice.test@example.invalid").value).toContain("[REDACTED_EMAIL]");
    expect(sanitizeString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz").decision).toBe(
      "drop",
    );
  });

  it("rejects unsafe attributes without traversing arbitrary objects", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("unsafe");
        },
      },
    );
    const getterObject = {};
    Object.defineProperty(getterObject, "safe", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });

    expect(sanitizeAttributes({ email: "alice.test@example.invalid", ok: "yes" }).value).toEqual({
      ok: "yes",
    });
    expect(sanitizeAttributes({ password: "hidden", ok: "yes" }).decision).toBe("drop");
    expect(sanitizeAttributes({ proxy }).value).toEqual({});
    expect(sanitizeAttributes(proxy).value).toEqual({});
    expect(sanitizeAttributes(getterObject).value).toEqual({});
  });

  it("drops action names with identifiers or secrets", () => {
    expect(sanitizeAction("checkout.submit", { ok: true }).decision).toBe("accept");
    expect(sanitizeAction("checkout.1234567890123", {}).decision).toBe("drop");
    expect(sanitizeAction("checkout.alice.test@example.invalid", {}).decision).toBe("drop");
    expect(sanitizeAction("checkout.submit", { token: "hidden" }).decision).toBe("drop");
  });

  it("sanitizes error message, stack and context without leaking raw values", () => {
    const error = new Error(
      "failed for alice.test@example.invalid id 12345678901234567890 at /x?token=value",
    );
    error.stack =
      "Error: boom\n    at route /users/12345678901234567890?email=alice.test@example.invalid";
    const result = sanitizeError(error, {
      email: "alice.test@example.invalid",
      screen: "checkout",
    });
    expect(result.decision).toBe("redact");
    expect(JSON.stringify(result.value)).not.toContain("alice.test@example.invalid");
    expect(JSON.stringify(result.value)).not.toContain("12345678901234567890");
    expect(result.value.context).toEqual({ screen: "checkout" });
  });

  it("drops secret-bearing errors fail-closed", () => {
    const result = sanitizeError(new Error("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"));
    expect(result.decision).toBe("drop");
    expect(result.reasons).toContain(ReasonCodes.SECRET_DETECTED);
  });

  it("sanitizes native RUM event fields through beforeSend contract", () => {
    const counters = createCounters();
    const event = {
      type: "action",
      action: { type: "click", target: { name: "Pay Alice alice.test@example.invalid" } },
      view: { url: "/checkout?card=4111111111111111#x" },
      context: { email: "alice.test@example.invalid", source: "button" },
    };
    expect(sanitizeRumEvent(event, { counters })).toBeUndefined();
    expect(event.action.target.name).toBe("interaction.click");
    expect(event.view.url).toBe("/__sensitive__");
    expect(event.context).toEqual({ source: "button" });
    expect(counters.sanitization.redacted).toBe(1);
  });

  it("drops unknown native RUM event types and secret logs", () => {
    const counters = createCounters();
    expect(sanitizeRumEvent({ type: "mystery" }, { counters })).toBe(false);
    expect(
      sanitizeLogEvent(
        { message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", status: "info" },
        { counters },
      ),
    ).toBe(false);
    expect(counters.sanitization.dropped).toBe(2);
  });
});
