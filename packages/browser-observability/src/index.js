import { recordAction as _recordAction } from "./actions/record-action.js";
import { initializeObservability as _initializeObservability } from "./bootstrap/initialize.js";
import { setTrackingConsent as _setTrackingConsent } from "./consent/set-tracking-consent.js";
import { recordError as _recordError } from "./errors/record-error.js";
import { publicFallback, safeCall } from "./internal/safe-call.js";
import { shutdownObservability as _shutdownObservability } from "./lifecycle/shutdown.js";
import { getObservabilityStatus as _getObservabilityStatus } from "./status/get-observability-status.js";

const ERROR_STATUS_FALLBACK = Object.freeze({
  state: "disabled",
  enabled: false,
  consent: "not-granted",
  service: null,
  environment: null,
  version: null,
  configVersion: null,
  adapter: null,
  reasonCode: "INTERNAL_ERROR",
  initializedAt: null,
  lastTransitionAt: null,
  counters: Object.freeze({
    acceptedActions: 0,
    droppedActions: 0,
    acceptedErrors: 0,
    droppedErrors: 0,
  }),
  sanitization: Object.freeze({
    accepted: 0,
    redacted: 0,
    dropped: 0,
    reasons: Object.freeze({}),
  }),
  correlation: Object.freeze({
    state: "unavailable",
    schemaVersion: 1,
    capabilities: Object.freeze({
      epoch: false,
      session: false,
      view: false,
      action: false,
      crossStream: false,
    }),
    counters: Object.freeze({
      enriched: 0,
      partial: 0,
      unavailable: 0,
      invalidNativeId: 0,
      reservedFieldRemoved: 0,
    }),
    lastReasonCode: "INTERNAL_ERROR",
  }),
  runtimeControl: Object.freeze({
    state: "invalid",
    revision: null,
    expiresAt: null,
    lastCheckedAt: null,
    lastAppliedAt: null,
    consecutiveFailures: 0,
    killSwitch: Object.freeze({ active: false, latched: false, reasonCode: "none" }),
    counters: Object.freeze({
      refreshSucceeded: 0,
      refreshFailed: 0,
      invalidRejected: 0,
      rollbackRejected: 0,
      expiredFailClosed: 0,
      killSwitchActivated: 0,
    }),
  }),
});

/**
 * Initializes the observability package for the current page. Never throws;
 * inspect the returned { ok, reason } instead.
 */
export const initializeObservability = (options) =>
  safeCall(() => _initializeObservability(options), Promise.resolve(publicFallback()));

/**
 * Records the visitor's tracking consent decision ("granted" | "not-granted").
 * Any other value (including legacy callers passing "denied" or "unknown")
 * fails closed to "not-granted" — see src/internal/constants.js and
 * src/consent/consent-manager.js. Never throws.
 */
export const setTrackingConsent = (consent) =>
  safeCall(() => _setTrackingConsent(consent), publicFallback());

/** Records a bounded, sanitized custom action. Never throws. */
export const recordAction = (name, attributes) =>
  safeCall(() => _recordAction(name, attributes), publicFallback());

/** Records a bounded, sanitized error. Never throws. */
export const recordError = (error, context) =>
  safeCall(() => _recordError(error, context), publicFallback());

/** Returns a read-only snapshot of the current package status. Never throws. */
export const getObservabilityStatus = () =>
  safeCall(() => _getObservabilityStatus(), ERROR_STATUS_FALLBACK);

/** Stops all collection and resets internal state. Never throws. */
export const shutdownObservability = () =>
  safeCall(() => _shutdownObservability(), Promise.resolve(publicFallback()));
