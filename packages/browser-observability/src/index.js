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
 * Initializes browser observability for the current page.
 *
 * @param {{configUrl?: string, service: string, environment: "development"|"test"|"staging"|"production"|"lab", version: string}} options
 * Host application identity and optional same-origin runtime config URL.
 * @returns {Promise<{ok: boolean, reason?: string, reasonCode?: string}>}
 * Resolves with an outcome object. It never throws; invalid options, disabled
 * config, expired config, runtime-control HOLD, missing consent, SDK load
 * failure, or internal failures are reported through reason/reasonCode.
 */
export const initializeObservability = (options) =>
  safeCall(() => _initializeObservability(options), Promise.resolve(publicFallback()));

/**
 * Records the visitor's tracking consent decision.
 *
 * @param {"granted"|"not-granted"|string} consent
 * Only `"granted"` enables collection. Any other value fails closed to
 * `"not-granted"`.
 * @returns {{ok: boolean, reason?: string, reasonCode?: string}}
 * Outcome object. Never throws.
 */
export const setTrackingConsent = (consent) =>
  safeCall(() => _setTrackingConsent(consent), publicFallback());

/**
 * Records a bounded, sanitized custom action.
 *
 * @param {string} name Dot-delimited low-cardinality action name.
 * @param {Record<string, string|number|boolean|null|undefined>=} attributes
 * Optional primitive attributes. Sensitive keys/values are dropped or rejected.
 * @returns {{ok: boolean, reason?: string, reasonCode?: string}}
 * Outcome object. Never throws, and never captures DOM, form, canvas, video, or replay payloads.
 */
export const recordAction = (name, attributes) =>
  safeCall(() => _recordAction(name, attributes), publicFallback());

/**
 * Records a bounded, sanitized error.
 *
 * @param {unknown} error Error-like value to sanitize.
 * @param {Record<string, string|number|boolean|null|undefined>=} context
 * Optional primitive context. Headers, bodies, cookies, tokens, identity, raw IP
 * and URL query/fragment values are removed or rejected.
 * @returns {{ok: boolean, reason?: string, reasonCode?: string}}
 * Outcome object. Never throws.
 */
export const recordError = (error, context) =>
  safeCall(() => _recordError(error, context), publicFallback());

/**
 * Returns a read-only snapshot of the current package status.
 *
 * @returns {Readonly<Record<string, unknown>>}
 * Status snapshot with lifecycle, consent, counters, sanitization,
 * correlation, and runtime-control state. Never throws.
 */
export const getObservabilityStatus = () =>
  safeCall(() => _getObservabilityStatus(), ERROR_STATUS_FALLBACK);

/**
 * Stops collection for the current page and resets local runtime state.
 *
 * @returns {Promise<{ok: boolean, reason?: string, reasonCode?: string}>}
 * Outcome object. Never throws; a later initialize call may resume only with
 * the same SDK connection identity.
 */
export const shutdownObservability = () =>
  safeCall(() => _shutdownObservability(), Promise.resolve(publicFallback()));
