import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  recordError,
  setTrackingConsent,
  shutdownObservability,
} from "@chicek/browser-observability";

const MOCK_API_BASE_URL = import.meta.env.VITE_MOCK_API_BASE_URL ?? "http://127.0.0.1:4311";

export function initializeScenario() {
  return initializeObservability({ applicationId: "demo-frontend-fixture" });
}

export function duplicateInitializeScenario() {
  return initializeObservability({ applicationId: "demo-frontend-fixture-duplicate" });
}

export function configFailureScenario() {
  return initializeObservability({ applicationId: "" });
}

export function shutdownScenario() {
  return shutdownObservability();
}

export function grantConsentScenario() {
  return setTrackingConsent("granted");
}

export function revokeConsentScenario() {
  return setTrackingConsent("denied");
}

export function statusScenario() {
  return getObservabilityStatus();
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
  return recordAction("demo.long_task", { durationMs: Math.round(performance.now() - start) });
}

async function fetchScenario(path, options) {
  try {
    const response = await fetch(`${MOCK_API_BASE_URL}${path}`, options);
    return recordAction("demo.request_completed", { path, status: response.status });
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
  return recordAction("demo.telemetry_failure", { scenario: "telemetry-failure" });
}
