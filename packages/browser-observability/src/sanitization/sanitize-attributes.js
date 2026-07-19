import { sanitizeAttributes as sanitizeAttributeResult } from "./sanitizers/attributes.js";

/**
 * Keeps only primitive (string/number/boolean) attribute values with
 * well-formed keys, bounded in count and length. Objects, arrays,
 * functions, and symbols are dropped rather than causing a throw.
 */
export function sanitizeAttributes(attributes) {
  const result = sanitizeAttributeResult(attributes);
  return result.value ?? {};
}
