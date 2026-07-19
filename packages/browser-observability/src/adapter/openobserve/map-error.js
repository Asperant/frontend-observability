import { sanitizeAttributes } from "../../sanitization/sanitize-attributes.js";
import { sanitizeError } from "../../sanitization/sanitize-error.js";

/**
 * Maps a validated recordError(error, context) call to the shape the
 * OpenObserve RUM/Logs SDKs expect. record-error.js already converts the
 * input to a bounded plain error payload, so this mapper never forwards a
 * host-owned Error object with unsanitized stack/message fields.
 */
export function mapError(error, context) {
  const safeContext = sanitizeAttributes(context);
  const sanitized = sanitizeError(error);
  const safeError = new Error(sanitized.message);
  safeError.name = sanitized.name;
  if (sanitized.stack) safeError.stack = sanitized.stack;
  return Object.freeze({ error: safeError, context: safeContext });
}
