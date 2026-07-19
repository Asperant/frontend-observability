// Same-origin, exact canonical endpoint for the narrow runtime-control
// overlay document (Stage 14) — deliberately distinct from the immutable
// SDK-initialization runtime config served at /observability/config.json.
export const CONTROL_ENDPOINT_PATH = "/observability/control.json";

export const CONTROL_SCHEMA_VERSION = 1;

export const CONTROL_FETCH_TIMEOUT_MS = 3000;
export const MAX_CONTROL_BODY_BYTES = 8 * 1024;

export const MAX_CONTROL_TTL_MS = 10 * 60 * 1000;
// How far into the future issuedAt may sit relative to the client clock
// before being rejected outright as implausible, as opposed to a normal
// clock-skew tolerance.
export const CONTROL_CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

export const REFRESH_INTERVAL_MS = 30 * 1000;
export const MIN_REFRESH_INTERVAL_MS = 15 * 1000;
export const MAX_REFRESH_INTERVAL_MS = 300 * 1000;

// Fixed failure backoff ladder: 15s -> 30s -> 60s -> 120s -> 300s, then
// holds at the final rung until a refresh succeeds again.
export const BACKOFF_LADDER_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]);

export const KILL_SWITCH_REASON_CODES = Object.freeze([
  "none",
  "security_incident",
  "privacy_incident",
  "service_degradation",
  "maintenance",
  "operator_request",
]);

export const CONTROL_TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "revision",
  "issuedAt",
  "expiresAt",
  "killSwitch",
]);

export const CONTROL_KILL_SWITCH_KEYS = Object.freeze(["active", "reasonCode"]);

export const RuntimeControlStates = Object.freeze({
  FRESH: "fresh",
  REFRESHING: "refreshing",
  DEGRADED: "degraded",
  EXPIRED: "expired",
  INVALID: "invalid",
  ROLLBACK_REJECTED: "rollback-rejected",
  KILL_SWITCHED: "kill-switched",
});
