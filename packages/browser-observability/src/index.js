import { recordAction as _recordAction } from "./actions/record-action.js";
import { initializeObservability as _initializeObservability } from "./bootstrap/initialize.js";
import { setTrackingConsent as _setTrackingConsent } from "./consent/set-tracking-consent.js";
import { recordError as _recordError } from "./errors/record-error.js";
import { withSafeGuard } from "./internal/with-safe-guard.js";
import { shutdownObservability as _shutdownObservability } from "./lifecycle/shutdown.js";
import { getObservabilityStatus as _getObservabilityStatus } from "./status/get-observability-status.js";

const ERROR_STATUS_FALLBACK = Object.freeze({
  status: "error",
  consent: "unknown",
  applicationId: null,
  privacyProfile: null,
  initializedAt: null,
  lastError: "status_unavailable",
  diagnosticsCount: 0,
});

/**
 * Initializes the observability package for the current page. Never throws;
 * inspect the returned { ok, reason } instead.
 */
export const initializeObservability = withSafeGuard(_initializeObservability, {
  ok: false,
  reason: "internal_error",
});

/**
 * Records the visitor's tracking consent decision ("granted" | "denied" | "unknown").
 * Never throws.
 */
export const setTrackingConsent = withSafeGuard(_setTrackingConsent, {
  ok: false,
  reason: "internal_error",
});

/** Records a bounded, sanitized custom action. Never throws. */
export const recordAction = withSafeGuard(_recordAction, {
  ok: false,
  reason: "internal_error",
});

/** Records a bounded, sanitized error. Never throws. */
export const recordError = withSafeGuard(_recordError, {
  ok: false,
  reason: "internal_error",
});

/** Returns a read-only snapshot of the current package status. Never throws. */
export const getObservabilityStatus = withSafeGuard(_getObservabilityStatus, ERROR_STATUS_FALLBACK);

/** Stops all collection and resets internal state. Never throws. */
export const shutdownObservability = withSafeGuard(_shutdownObservability, {
  ok: false,
  reason: "internal_error",
});
