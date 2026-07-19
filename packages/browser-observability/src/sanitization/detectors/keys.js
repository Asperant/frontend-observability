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

export function normalizeKeyForPolicy(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function forbiddenKeyReason(key) {
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
