import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { normalizeKeyForPolicy } from "../sanitization/detectors/keys.js";
import { recordCorrelation } from "./counters.js";

const RESERVED_KEY_CATEGORIES = Object.freeze([
  "chicek",
  "correlation",
  "session",
  "view",
  "action",
  "trace",
  "span",
  "dd",
]);

export function isReservedCorrelationKey(key) {
  const normalized = normalizeKeyForPolicy(key);
  return RESERVED_KEY_CATEGORIES.some((category) => normalized.includes(category));
}

export function stripReservedFields(value, { counters } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, removed: false };
  }
  let removed = false;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (isReservedCorrelationKey(key)) {
      removed = true;
      continue;
    }
    next[key] = item;
  }
  if (removed) {
    recordCorrelation(counters, "reservedFieldRemoved");
  }
  return {
    value: Object.freeze(next),
    removed,
    reasonCode: removed ? ReasonCodes.CORRELATION_RESERVED_FIELD_REMOVED : ReasonCodes.NONE,
  };
}
