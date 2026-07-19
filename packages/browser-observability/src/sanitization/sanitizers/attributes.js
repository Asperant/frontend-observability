import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { forbiddenKeyReason, isSecretKey } from "../detectors/keys.js";
import { accept, drop, redact } from "../diagnostics/results.js";
import { byteLength } from "../limits/limits.js";
import { sanitizeString } from "./string.js";

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

export function sanitizeAttributes(attributes, { maxBytes = 2 * 1024, maxItems = 12 } = {}) {
  try {
    if (attributes === undefined || attributes === null) return accept({});
    if (!isPlainObject(attributes)) return redact({}, [ReasonCodes.ATTRIBUTE_VALUE_UNSAFE]);

    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(attributes);
    } catch {
      return redact({}, [ReasonCodes.ATTRIBUTE_VALUE_UNSAFE]);
    }

    const sanitized = {};
    const reasons = [];
    let count = 0;
    let totalBytes = 0;

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (count >= maxItems) break;
      if (!isSafeKey(key)) {
        reasons.push(ReasonCodes.ATTRIBUTE_KEY_FORBIDDEN);
        continue;
      }
      const forbiddenReason = forbiddenKeyReason(key);
      if (forbiddenReason) {
        if (isSecretKey(key)) return drop(ReasonCodes.SECRET_DETECTED);
        reasons.push(forbiddenReason);
        continue;
      }
      if ("get" in descriptor || "set" in descriptor) {
        reasons.push(ReasonCodes.ATTRIBUTE_VALUE_UNSAFE);
        continue;
      }

      const valueResult = sanitizeAttributeValue(descriptor.value);
      if (valueResult.decision === "drop") {
        if (valueResult.reasons.includes(ReasonCodes.SECRET_DETECTED)) return valueResult;
        reasons.push(...valueResult.reasons);
        continue;
      }

      const nextBytes = byteLength(key) + byteLength(JSON.stringify(valueResult.value));
      if (totalBytes + nextBytes > maxBytes) {
        reasons.push(ReasonCodes.PAYLOAD_TOO_LARGE);
        break;
      }
      sanitized[key] = valueResult.value;
      reasons.push(...valueResult.reasons);
      totalBytes += nextBytes;
      count += 1;
    }

    return reasons.length > 0
      ? redact(Object.freeze(sanitized), [...new Set(reasons)])
      : accept(Object.freeze(sanitized));
  } catch {
    return drop(ReasonCodes.SANITIZER_FAILURE);
  }
}

function sanitizeAttributeValue(value) {
  if (value === null || typeof value === "boolean") return accept(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? accept(value) : drop(ReasonCodes.ATTRIBUTE_VALUE_UNSAFE);
  }
  if (typeof value === "string") return sanitizeString(value, { maxLength: 128 });
  return drop(ReasonCodes.ATTRIBUTE_VALUE_UNSAFE);
}

function isSafeKey(key) {
  return (
    typeof key === "string" && key.length > 0 && key.length <= 48 && SAFE_KEY_PATTERN.test(key)
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
