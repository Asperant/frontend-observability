import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { FORBIDDEN_KEY_CATEGORIES } from "../policy/baseline.js";

const SECRET_KEY_CATEGORIES = Object.freeze([
  "password",
  "secret",
  "token",
  "authorization",
  "cookie",
  "session",
  "csrf",
]);

// Exact (case-sensitive) reserved property names, not a substring category
// like FORBIDDEN_KEY_CATEGORIES below: an own enumerable "__proto__" key
// (e.g. from JSON.parse, which never invokes the accessor) assigned via
// bracket notation into a plain-object accumulator elsewhere in the
// sanitizer changes that object's prototype instead of storing a data
// property, silently reshaping what reaches the adapter. Matching by exact
// name (not a "proto"/"constructor" substring) avoids rejecting legitimate
// keys such as "protocol".
const RESERVED_OBJECT_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

export function isReservedObjectKey(key) {
  return RESERVED_OBJECT_KEYS.includes(key);
}

export function normalizeKeyForPolicy(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function forbiddenKeyReason(key) {
  if (isReservedObjectKey(key)) {
    return ReasonCodes.ATTRIBUTE_KEY_FORBIDDEN;
  }
  const normalized = normalizeKeyForPolicy(key);
  if (FORBIDDEN_KEY_CATEGORIES.some((category) => normalized.includes(category))) {
    return ReasonCodes.ATTRIBUTE_KEY_FORBIDDEN;
  }
  return null;
}

export function isSecretKey(key) {
  const normalized = normalizeKeyForPolicy(key);
  return SECRET_KEY_CATEGORIES.some((category) => normalized.includes(category));
}
