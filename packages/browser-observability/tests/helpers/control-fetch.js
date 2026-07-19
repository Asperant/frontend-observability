import { CONTROL_ENDPOINT_PATH } from "../../src/runtime-control/constants.js";

/**
 * A schema-valid, currently-live runtime-control document. Timestamps are
 * always computed relative to the real wall clock (not a fixed literal) so
 * this stays valid (TTL <= 10min, expiresAt in the future) no matter when a
 * test actually runs.
 */
export function validControlDocument(overrides = {}) {
  const now = new Date();
  return {
    schemaVersion: 1,
    revision: 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    killSwitch: { active: false, reasonCode: "none" },
    ...overrides,
  };
}

export function controlJsonResponse(body = validControlDocument()) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Wraps a pre-Stage-14 fetch mock (written when initializeObservability()
 * only ever made one fetch call, for the runtime config) so requests to the
 * new, independent /observability/control.json endpoint always get a valid
 * response, while every other URL keeps going through the original mock
 * unchanged.
 */
export function fetchRouter(defaultHandler) {
  return (url, init) => {
    if (isControlUrl(url)) return Promise.resolve(controlJsonResponse());
    return typeof defaultHandler === "function" ? defaultHandler(url, init) : defaultHandler;
  };
}

function isControlUrl(url) {
  try {
    return new URL(String(url), "https://control.invalid").pathname === CONTROL_ENDPOINT_PATH;
  } catch {
    return String(url) === CONTROL_ENDPOINT_PATH;
  }
}
