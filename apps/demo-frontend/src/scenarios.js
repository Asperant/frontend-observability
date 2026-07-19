import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  recordError,
  setTrackingConsent,
  shutdownObservability,
} from "@chicek/browser-observability";

import { DEMO_IDENTITY } from "./identity.js";

const MOCK_API_BASE_URL = import.meta.env.VITE_MOCK_API_BASE_URL ?? "http://127.0.0.1:4311";

const BASE_OPTIONS = DEMO_IDENTITY;

export function initializeScenario() {
  return initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/valid-enabled.json",
  });
}

/**
 * Initializes against the served /observability/config.json with no
 * override. In the Docker lab this is nginx's alias for the real,
 * generated runtime config (real RUM site/token); everywhere else it is
 * this app's own bundled, disabled-by-default config.json. This is the
 * scenario Stage 8's OpenObserve integration verification drives.
 */
export function initializeRuntimeConfigScenario() {
  return initializeObservability(BASE_OPTIONS);
}

export function duplicateInitializeScenario() {
  return initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/valid-enabled.json",
  });
}

export async function concurrentInitializeScenario() {
  const options = {
    ...BASE_OPTIONS,
    configUrl: "/observability/valid-enabled.json",
  };
  const [first, second] = await Promise.all([
    initializeObservability(options),
    initializeObservability(options),
  ]);
  return { first, second };
}

export async function conflictingInitializeScenario() {
  const first = initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/valid-enabled.json",
  });
  const second = initializeObservability({
    ...BASE_OPTIONS,
    service: "demo-other",
    configUrl: "/observability/valid-enabled.json",
  });
  const results = await Promise.all([first, second]);
  return { first: results[0], second: results[1] };
}

export function invalidConfigScenario() {
  return initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/invalid-schema.json",
  });
}

export function expiredConfigScenario() {
  return initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/expired.json",
  });
}

export function configTimeoutScenario() {
  return initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/timeout.json",
  });
}

export function disabledConfigScenario() {
  return initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/valid-disabled.json",
  });
}

export function configFailureScenario() {
  return initializeObservability({ ...BASE_OPTIONS, service: "" });
}

export function shutdownScenario() {
  return shutdownObservability();
}

export function reinitializeScenario() {
  return initializeObservability({
    ...BASE_OPTIONS,
    configUrl: "/observability/valid-disabled.json",
  });
}

export function grantConsentScenario() {
  return setTrackingConsent("granted");
}

export function revokeConsentScenario() {
  return setTrackingConsent("not-granted");
}

export function statusScenario() {
  return getObservabilityStatus();
}

export function recordActionScenario() {
  return recordAction("demo.record-action", { source: "button" });
}

export function recordErrorScenario() {
  return recordError(new Error("Demo recorded error"), { source: "button" });
}

export function runtimeErrorScenario() {
  setTimeout(() => {
    // Intentionally uncaught: captured by the window "error" listener in App.jsx,
    // mirroring how a real uncaught runtime error reaches a RUM SDK.
    // eslint-disable-next-line no-undef
    demoRuntimeErrorTrigger();
  }, 0);
  return { ok: true, reason: "triggered" };
}

export function unhandledRejectionScenario() {
  // Intentionally unhandled: captured by the window "unhandledrejection" listener.
  Promise.reject(new Error("Demo unhandled promise rejection"));
  return { ok: true, reason: "triggered" };
}

export function resourceErrorScenario() {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("error", () => {
      resolve(recordError(new Error("Resource failed to load"), { scenario: "resource-error" }));
    });
    image.src = "/definitely-missing-asset.png";
  });
}

export function longTaskScenario() {
  const start = performance.now();
  // Deliberately blocks the main thread briefly to simulate a long task.
  while (performance.now() - start < 60) {
    // busy wait
  }
  return recordAction("demo.long-task", { durationMs: Math.round(performance.now() - start) });
}

async function fetchScenario(path, options) {
  try {
    const response = await fetch(`${MOCK_API_BASE_URL}${path}`, options);
    return recordAction("demo.request-completed", { path, status: response.status });
  } catch (error) {
    return recordError(error, { scenario: "request-failed", path });
  }
}

export function successfulRequestScenario() {
  return fetchScenario("/status/200");
}

export function clientErrorScenario() {
  return fetchScenario("/status/400");
}

export function serverErrorScenario() {
  return fetchScenario("/status/500");
}

export function timeoutScenario() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  return fetchScenario("/timeout", { signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

export function abortScenario() {
  const controller = new AbortController();
  const request = fetchScenario("/delay/2000", { signal: controller.signal });
  controller.abort();
  return request;
}

export function telemetryFailureScenario() {
  // Demonstrates that recordAction() fails safely (no throw) when the
  // package has not been initialized or consent has not been granted.
  return recordAction("demo.telemetry-failure", { scenario: "telemetry-failure" });
}

export function safeActionScenario() {
  return recordAction("demo.safe-action", { source: "panel", result: "ok" });
}

export function piiRedactedActionScenario() {
  return recordAction("demo.pii-action", {
    source: "panel",
    synthetic: "alice.test@example.invalid 12345678901234567890",
  });
}

export function secretDroppedActionScenario() {
  return recordAction("demo.secret-action", {
    source: "panel",
    secret: "Bearer abcdefghijklmnopqrstuvwxyz",
  });
}

export function piiRedactedErrorScenario() {
  return recordError(
    new Error("Synthetic contact alice.test@example.invalid id 12345678901234567890"),
    { source: "panel" },
  );
}

export function secretDroppedErrorScenario() {
  return recordError(new Error("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), {
    source: "panel",
  });
}

export function urlNormalizationScenario() {
  return recordError(new Error("Synthetic URL /users/12345678901234567890?email=a#token"), {
    source: "panel",
  });
}

export function unsafeAttributesScenario() {
  return recordAction("demo.unsafe-attributes", {
    source: "panel",
    nested: { unsafe: true },
    email: "alice.test@example.invalid",
  });
}

export function networkUrlSanitizationScenario() {
  return fetchScenario("/status/200?email=alice.test@example.invalid#token");
}

export function sanitizationCountersScenario() {
  return getObservabilityStatus().sanitization;
}
