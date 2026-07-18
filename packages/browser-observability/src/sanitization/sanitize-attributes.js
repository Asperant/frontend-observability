import {
  ATTRIBUTE_KEY_PATTERN,
  MAX_ATTRIBUTE_COUNT,
  MAX_ATTRIBUTE_KEY_LENGTH,
  MAX_STRING_ATTRIBUTE_LENGTH,
} from "../internal/constants.js";

/**
 * Keeps only primitive (string/number/boolean) attribute values with
 * well-formed keys, bounded in count and length. Objects, arrays,
 * functions, and symbols are dropped rather than causing a throw.
 */
export function sanitizeAttributes(attributes) {
  if (attributes === undefined || attributes === null) {
    return {};
  }
  if (typeof attributes !== "object" || Array.isArray(attributes)) {
    return {};
  }

  const sanitized = {};
  let count = 0;

  for (const [key, value] of Object.entries(attributes)) {
    if (count >= MAX_ATTRIBUTE_COUNT) break;
    if (key.length > MAX_ATTRIBUTE_KEY_LENGTH || !ATTRIBUTE_KEY_PATTERN.test(key)) continue;

    if (typeof value === "string") {
      sanitized[key] = value.slice(0, MAX_STRING_ATTRIBUTE_LENGTH);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
    } else {
      continue;
    }
    count += 1;
  }

  return sanitized;
}
