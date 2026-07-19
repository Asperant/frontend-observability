import { describe, expect, it } from "vitest";

import { ReasonCodes } from "../src/diagnostics/reason-codes.js";
import { createCounters } from "../src/diagnostics/counters.js";
import { sanitizeAttributes as sanitizeAttributesCompat } from "../src/sanitization/sanitize-attributes.js";
import { sanitizeError as sanitizeErrorCompat } from "../src/sanitization/sanitize-error.js";
import {
  containsSecret,
  hasHighRiskIdentifier,
} from "../src/sanitization/detectors/sensitive-values.js";
import {
  accept,
  drop,
  mergeDecision,
  redact,
  uniqueReasons,
} from "../src/sanitization/diagnostics/results.js";
import { byteLength, truncateByChars } from "../src/sanitization/limits/limits.js";
import { buildSanitizationPolicy } from "../src/sanitization/policy/baseline.js";
import { sanitizeAction, sanitizeActionName } from "../src/sanitization/sanitizers/action.js";
import { sanitizeAttributes } from "../src/sanitization/sanitizers/attributes.js";
import { sanitizeError, sanitizeStack } from "../src/sanitization/sanitizers/error.js";
import { sanitizeLogEvent, sanitizeRumEvent } from "../src/sanitization/sanitizers/events.js";
import { sanitizeResource } from "../src/sanitization/sanitizers/resource.js";
import { sanitizeString, stripUrlQueryAndFragment } from "../src/sanitization/sanitizers/string.js";
import { sanitizeUrl } from "../src/sanitization/sanitizers/url.js";

describe("sanitization branch coverage", () => {
  it("covers result helpers", () => {
    expect(mergeDecision([accept("ok")])).toBe("accept");
    expect(mergeDecision([accept("ok"), redact("safe", ["x"])])).toBe("redact");
    expect(mergeDecision([accept("ok"), drop("x")])).toBe("drop");
    expect(uniqueReasons([redact("a", ["x", "x"]), drop("y")])).toEqual(["x", "y"]);
    expect(uniqueReasons([{}])).toEqual([]);
  });

  it("covers detector non-string branches", () => {
    expect(containsSecret(10)).toBe(false);
    expect(hasHighRiskIdentifier(10)).toBe(false);
  });

  it("covers legacy sanitizer wrapper fallbacks", () => {
    expect(sanitizeAttributesCompat({ token: "hidden" })).toEqual({});
    expect(sanitizeErrorCompat(new Error("Authorization: Bearer hiddenvalue1234567890"))).toEqual({
      name: "UnknownError",
      message: "Unknown error",
    });
  });

  it("covers policy and limit helpers", () => {
    const policy = buildSanitizationPolicy({ excludedRoutes: ["/Admin", "relative", 10] });
    expect(policy.sensitiveRoutes).toContain("/admin");
    expect(policy.sensitiveRoutes).not.toContain("relative");
    expect(buildSanitizationPolicy({ excludedRoutes: "not-array" }).sensitiveRoutes).toContain(
      "/login",
    );
    expect(byteLength("abc")).toBe(3);
    expect(truncateByChars("abcdef", 3)).toBe("abc");
    expect(truncateByChars("abcdef", 10)).toBe("abcdef");
  });

  it("covers URL validation and normalization branches", () => {
    expect(sanitizeUrl("", { baseUrl: "https://app.example.invalid/" }).decision).toBe("drop");
    expect(
      sanitizeUrl("x".repeat(1025), { baseUrl: "https://app.example.invalid/" }).decision,
    ).toBe("drop");
    expect(sanitizeUrl("ftp://example.invalid/x").decision).toBe("drop");
    expect(sanitizeUrl("/%E0%A4%A", { baseUrl: "https://app.example.invalid/" }).decision).toBe(
      "drop",
    );
    expect(
      sanitizeUrl("/assets/app.a1b2c3d4.js", { baseUrl: "https://app.example.invalid/" }).value,
    ).toBe("/assets/app.:hash.js");
    expect(
      sanitizeUrl("/opaque/abcdefghijklmnopqrstuvwxyz123456", {
        baseUrl: "https://app.example.invalid/",
      }).value,
    ).toBe("/opaque/:opaque");
    expect(sanitizeUrl("/space here", { baseUrl: "https://app.example.invalid/" }).value).toBe(
      "/space%20here",
    );
    expect(sanitizeUrl("/x", { baseUrl: "not a url" }).decision).toBe("drop");
    expect(
      sanitizeUrl("https://cdn.example.invalid/a/1234567890.png", {
        baseUrl: "https://app.example.invalid/",
        resource: true,
      }).value,
    ).toBe("https://cdn.example.invalid/a/1234567890.png");
  });

  it("covers string sanitization branches", () => {
    const userInfoUrl = "https://" + "user:pass@" + "example.invalid/path?q=1#x";
    expect(sanitizeString(42).value).toBe(42);
    expect(sanitizeString(userInfoUrl).value).toBe("https://example.invalid/path");
    expect(sanitizeString("see /orders/123?debug=true#x").value).toBe("see /orders/123");
    expect(stripUrlQueryAndFragment("bad https://%")).toBe("bad [REDACTED_URL]");
    expect(sanitizeString("secret=value", { dropSecrets: false }).value).toBe("");
    expect(sanitizeString("x".repeat(200), { maxLength: 10 }).value).toBe("[REDACTED_");
  });

  it("covers attribute safety branches", () => {
    const getterObject = {};
    Object.defineProperty(getterObject, "safe", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const descriptorProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const protoProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("boom");
        },
      },
    );

    expect(sanitizeAttributes(getterObject).value).toEqual({});
    expect(sanitizeAttributes(descriptorProxy).value).toEqual({});
    expect(sanitizeAttributes(protoProxy).decision).toBe("drop");
    expect(sanitizeAttributes(Object.assign(Object.create(null), { safe: "yes" })).value).toEqual({
      safe: "yes",
    });
    expect(sanitizeAttributes({ ok: "yes", nested: {} }).value).toEqual({ ok: "yes" });
    expect(sanitizeAttributes({ ok: "yes", authorization: "Bearer x" }).decision).toBe("drop");
    expect(sanitizeAttributes({ ok: "Authorization: Bearer hiddenvalue1234567890" }).decision).toBe(
      "drop",
    );
    expect(sanitizeAttributes({ card: "4111111111111111", ok: true }).value).toEqual({ ok: true });
    expect(sanitizeAttributes({ a: "x".repeat(130), b: null }, { maxBytes: 16 }).reasons).toContain(
      ReasonCodes.PAYLOAD_TOO_LARGE,
    );
  });

  it("covers action validation branches", () => {
    expect(sanitizeActionName("ab").decision).toBe("drop");
    expect(sanitizeActionName("A.B").decision).toBe("drop");
    expect(sanitizeActionName("a..b").decision).toBe("drop");
    expect(sanitizeActionName("a.b.c.d.e.f.g").decision).toBe("drop");
    expect(sanitizeActionName("a".repeat(81)).decision).toBe("drop");
    expect(sanitizeActionName(10).decision).toBe("drop");
    expect(
      sanitizeAction("safe.action", { email: "alice.test@example.invalid", ok: "yes" }).value,
    ).toEqual({ name: "safe.action", attributes: { ok: "yes" } });
  });

  it("covers error sanitization branches", () => {
    const custom = new Error("boom");
    custom.stack = "";
    Object.defineProperty(custom, "name", {
      get() {
        throw new Error("boom");
      },
    });

    expect(sanitizeStack("").value).toBeUndefined();
    expect(sanitizeStack("Error\n".repeat(30)).value.split("\n")).toHaveLength(20);
    expect(sanitizeError("plain").value.error.name).toBe("Error");
    expect(sanitizeError(42).value.error.name).toBe("UnknownError");
    expect(sanitizeError(custom).value.error.name).toBe("UnknownError");
    expect(sanitizeError(new Error("boom"), { token: "hidden" }).decision).toBe("drop");
  });

  it("covers resource sanitizer", () => {
    expect(
      sanitizeResource(
        { url: "/assets/app.js" },
        {
          baseUrl: "https://app.example.invalid/",
        },
      ).value,
    ).toBe("/assets/app.js");
    expect(
      sanitizeResource(
        { url: "/rum/v1/default/logs" },
        {
          baseUrl: "https://app.example.invalid/",
        },
      ).decision,
    ).toBe("drop");
  });

  it("covers native RUM event branches", () => {
    const counters = createCounters();
    const common = {
      usr: { id: "u" },
      account: { id: "a" },
      user: { id: "u" },
      headers: { Authorization: "Bearer hidden" },
      request: { body: "raw" },
      response: { body: "raw" },
      body: "raw",
      payload: "raw",
    };

    const view = {
      ...common,
      type: "view",
      view: {
        url: "javascript:alert(1)",
        referrer: "file:///tmp/secret",
        name: "alice.test@example.invalid",
        performance: { lcp: { resource_url: "/observability/config.json" } },
      },
      context: { screen: "home" },
    };
    expect(sanitizeRumEvent(view, { counters })).toBe(false);
    expect(view.view.url).toBe("/");
    expect(view.view.referrer).toBeUndefined();
    expect(view.view.name).toBe("[REDACTED_EMAIL]");
    expect(view.view.performance.lcp.resource_url).toBeUndefined();

    const safeView = {
      type: "view",
      view: {
        url: "/home",
        referrer: "/previous?x=1",
        performance: { lcp: { resource_url: "/assets/app.a1b2c3d4.js" } },
      },
    };
    expect(sanitizeRumEvent(safeView, { counters })).toBeUndefined();
    expect(safeView.view.referrer).toBe("/previous");
    expect(safeView.view.performance.lcp.resource_url).toBe("/assets/app.:hash.js");

    const secretNamedView = {
      type: "view",
      view: { url: "/home", name: "Authorization: Bearer hiddenvalue1234567890" },
    };
    expect(sanitizeRumEvent(secretNamedView, { counters })).toBe(false);
    expect(secretNamedView.view.name).toBeUndefined();

    expect(
      sanitizeRumEvent({ type: "view", view: { url: "/home" } }, { counters }),
    ).toBeUndefined();

    const customAction = {
      type: "action",
      action: { type: "custom", target: { name: "checkout.submit" } },
      context: { ok: true },
    };
    expect(sanitizeRumEvent(customAction, { counters })).toBeUndefined();
    expect(customAction.action.target.name).toBe("checkout.submit");

    const badCustomAction = {
      type: "action",
      action: { type: "custom", target: { name: "checkout.alice.test@example.invalid" } },
    };
    expect(sanitizeRumEvent(badCustomAction, { counters })).toBe(false);

    const inputAction = {
      type: "action",
      action: { type: "application_start", target: { name: "raw" } },
    };
    expect(sanitizeRumEvent(inputAction, { counters })).toBeUndefined();
    expect(inputAction.action.target.name).toBe("interaction.submit");

    const unknownInteraction = {
      type: "action",
      action: { type: "drag", target: { name: "raw" } },
    };
    expect(sanitizeRumEvent(unknownInteraction, { counters })).toBeUndefined();
    expect(unknownInteraction.action.target.name).toBe("interaction.click");

    const resource = {
      type: "resource",
      resource: {
        url: "/api/users/1234567890?email=alice.test@example.invalid",
        graphql: { variables: { raw: true } },
      },
    };
    expect(sanitizeRumEvent(resource, { counters })).toBeUndefined();
    expect(resource.resource.url).toBe("/api/users/:id");
    expect(resource.resource.graphql.variables).toBeUndefined();

    const badResource = { type: "resource", resource: { url: "/rum/v1/default/rum" } };
    expect(sanitizeRumEvent(badResource, { counters })).toBe(false);

    const errorEvent = {
      type: "error",
      error: {
        message: "failed alice.test@example.invalid",
        stack: "Error\n at /x?email=alice.test@example.invalid",
        handling_stack: "Handling\n at /y?phone=15555550123",
        component_stack: "Component\n at /z#token",
        resource: { url: "/upload/file?secret=x" },
        causes: [
          {
            message: "cause alice.test@example.invalid",
            stack: "Stack\n at /a?x=1",
            type: "Type",
            source: "source",
          },
          null,
          { message: "second" },
          { message: "ignored" },
        ],
      },
    };
    expect(sanitizeRumEvent(errorEvent, { counters })).toBeUndefined();
    expect(errorEvent.error.message).toContain("[REDACTED_EMAIL]");
    expect(errorEvent.error.resource.url).toBe("/__sensitive__");
    expect(errorEvent.error.causes).toHaveLength(3);

    expect(sanitizeRumEvent({ type: "error" }, { counters })).toBeUndefined();
    expect(
      sanitizeRumEvent({ type: "error", error: { message: 10, stack: 10 } }, { counters }),
    ).toBeUndefined();

    const secretErrorEvent = {
      type: "error",
      error: { message: "Authorization: Bearer hiddenvalue1234567890" },
    };
    expect(sanitizeRumEvent(secretErrorEvent, { counters })).toBe(false);

    expect(
      sanitizeRumEvent(
        {
          type: "error",
          error: {
            stack: "Error\nAuthorization: Bearer hiddenvalue1234567890",
            resource: { url: "/safe" },
          },
        },
        { counters },
      ),
    ).toBe(false);
    expect(
      sanitizeRumEvent(
        {
          type: "error",
          error: {
            message: "safe",
            resource: { url: "javascript:alert(1)" },
          },
        },
        { counters },
      ),
    ).toBe(false);

    const longTask = {
      type: "long_task",
      long_task: {
        scripts: [
          { source_url: "/observability/config.json", invoker: "alice.test@example.invalid" },
          { source_url: "/assets/app.a1b2c3d4.js", invoker: "safe" },
        ],
      },
    };
    expect(sanitizeRumEvent(longTask, { counters })).toBe(false);
    expect(longTask.long_task.scripts[0].source_url).toBeUndefined();
    expect(longTask.long_task.scripts[0].invoker).toBe("[REDACTED_EMAIL]");

    expect(
      sanitizeRumEvent(
        {
          type: "long_task",
          long_task: { scripts: [{}, { invoker: "safe" }] },
        },
        { counters },
      ),
    ).toBeUndefined();
    expect(
      sanitizeRumEvent(
        {
          type: "long_task",
          long_task: { scripts: [{ invoker: "Authorization: Bearer hiddenvalue1234567890" }] },
        },
        { counters },
      ),
    ).toBe(false);
    expect(sanitizeRumEvent({ type: "long_task" }, { counters })).toBeUndefined();

    const vital = {
      type: "vital",
      vital: {
        name: "web-vital",
        step_type: "step",
        operation_key: "op",
        failure_reason: "alice.test@example.invalid",
        description: "ok",
      },
    };
    expect(sanitizeRumEvent(vital, { counters })).toBeUndefined();
    expect(vital.vital.failure_reason).toBe("[REDACTED_EMAIL]");
    expect(sanitizeRumEvent({ type: "vital" }, { counters })).toBeUndefined();
    expect(
      sanitizeRumEvent(
        {
          type: "vital",
          vital: { description: "Authorization: Bearer hiddenvalue1234567890" },
        },
        { counters },
      ),
    ).toBe(false);

    const secretContextAction = {
      type: "action",
      action: { type: "custom", target: { name: "safe.action" } },
      context: { token: "hidden" },
    };
    expect(sanitizeRumEvent(secretContextAction, { counters })).toBe(false);
    expect(secretContextAction.context).toBeUndefined();

    const throwingEvent = {};
    Object.defineProperty(throwingEvent, "type", {
      get() {
        throw new Error("boom");
      },
    });
    expect(sanitizeRumEvent(throwingEvent, { counters })).toBe(false);
  });

  it("covers native log event branches", () => {
    const counters = createCounters();
    expect(sanitizeLogEvent(null, { counters })).toBe(false);

    const log = {
      message: "log alice.test@example.invalid",
      error: {
        message: "error alice.test@example.invalid",
        stack: "Error\n at /x?email=alice.test@example.invalid",
        resource: { url: "/api/user/1234567890" },
        causes: [{ message: "cause 1234567890" }],
      },
      http: { url: "/checkout?card=4111111111111111" },
      usr: { id: "u" },
      account: { id: "a" },
      context: { email: "alice.test@example.invalid", safe: "yes" },
    };
    expect(sanitizeLogEvent(log, { counters })).toBeUndefined();
    expect(log.message).toContain("[REDACTED_EMAIL]");
    expect(log.error.resource.url).toBe("/api/user/:id");
    expect(log.http.url).toBe("/__sensitive__");
    expect(log.usr).toBeUndefined();
    expect(log.context).toEqual({ safe: "yes" });

    expect(
      sanitizeLogEvent(
        { http: { url: "javascript:alert(1)" }, context: { safe: "yes" } },
        { counters },
      ),
    ).toBe(false);
    expect(sanitizeLogEvent({ status: "info" }, { counters })).toBeUndefined();
  });
});
