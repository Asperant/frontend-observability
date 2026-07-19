import {
  CONTROL_CLOCK_SKEW_TOLERANCE_MS,
  CONTROL_KILL_SWITCH_KEYS,
  CONTROL_SCHEMA_VERSION,
  CONTROL_TOP_LEVEL_KEYS,
  KILL_SWITCH_REASON_CODES,
  MAX_CONTROL_TTL_MS,
} from "./constants.js";

export const ControlReasonCodes = Object.freeze({
  NONE: "NONE",
  SCHEMA_INVALID: "CONTROL_SCHEMA_INVALID",
  DUPLICATE_KEY: "CONTROL_DUPLICATE_KEY",
  UNKNOWN_KEY: "CONTROL_UNKNOWN_KEY",
  REVISION_INVALID: "CONTROL_REVISION_INVALID",
  ROLLBACK_REJECTED: "CONTROL_ROLLBACK_REJECTED",
  LIFETIME_INVALID: "CONTROL_LIFETIME_INVALID",
  TTL_EXCEEDED: "CONTROL_TTL_EXCEEDED",
  EXPIRED: "CONTROL_EXPIRED",
  NOT_YET_VALID: "CONTROL_NOT_YET_VALID",
});

/**
 * Structural + closed-vocabulary validation only — no notion of "now" and
 * no comparison against a previously accepted revision. Those are handled
 * separately (validateControlLifetime / revision comparison in
 * apply-document.js) so each rule stays independently testable.
 */
export function validateControlDocumentShape(doc) {
  if (!isPlainObject(doc)) {
    return invalid(ControlReasonCodes.SCHEMA_INVALID);
  }
  if (hasUnknownKey(doc, CONTROL_TOP_LEVEL_KEYS)) {
    return invalid(ControlReasonCodes.UNKNOWN_KEY);
  }
  if (doc.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    return invalid(ControlReasonCodes.SCHEMA_INVALID);
  }
  if (!isNonNegativeInteger(doc.revision)) {
    return invalid(ControlReasonCodes.REVISION_INVALID);
  }
  if (!isIsoString(doc.issuedAt) || !isIsoString(doc.expiresAt)) {
    return invalid(ControlReasonCodes.LIFETIME_INVALID);
  }
  if (!isPlainObject(doc.killSwitch)) {
    return invalid(ControlReasonCodes.SCHEMA_INVALID);
  }
  if (hasUnknownKey(doc.killSwitch, CONTROL_KILL_SWITCH_KEYS)) {
    return invalid(ControlReasonCodes.UNKNOWN_KEY);
  }
  if (typeof doc.killSwitch.active !== "boolean") {
    return invalid(ControlReasonCodes.SCHEMA_INVALID);
  }
  if (!KILL_SWITCH_REASON_CODES.includes(doc.killSwitch.reasonCode)) {
    return invalid(ControlReasonCodes.SCHEMA_INVALID);
  }
  return { valid: true, reasonCode: ControlReasonCodes.NONE };
}

/**
 * Time-based validation: expiresAt > issuedAt, TTL bounded to 10 minutes,
 * issuedAt not further in the future than a bounded clock-skew tolerance,
 * and expiresAt not already in the past relative to `now`.
 */
export function validateControlLifetime(doc, now = new Date()) {
  const issuedAtMs = Date.parse(doc?.issuedAt);
  const expiresAtMs = Date.parse(doc?.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    return invalid(ControlReasonCodes.LIFETIME_INVALID);
  }
  if (expiresAtMs <= issuedAtMs) {
    return invalid(ControlReasonCodes.LIFETIME_INVALID);
  }
  if (expiresAtMs - issuedAtMs > MAX_CONTROL_TTL_MS) {
    return invalid(ControlReasonCodes.TTL_EXCEEDED);
  }
  const nowMs = now.getTime();
  if (issuedAtMs > nowMs + CONTROL_CLOCK_SKEW_TOLERANCE_MS) {
    return invalid(ControlReasonCodes.NOT_YET_VALID);
  }
  if (expiresAtMs <= nowMs) {
    return invalid(ControlReasonCodes.EXPIRED);
  }
  return { valid: true, reasonCode: ControlReasonCodes.NONE };
}

function invalid(reasonCode) {
  return { valid: false, reasonCode };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnknownKey(object, allowedKeys) {
  return Object.keys(object).some((key) => !allowedKeys.includes(key));
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isIsoString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}
