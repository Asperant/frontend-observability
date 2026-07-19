import { sanitizeAttributes } from "../../sanitization/sanitize-attributes.js";
import { sanitizeError } from "../../sanitization/sanitize-error.js";

/**
 * Maps a validated recordError(error, context) call to the shape the
 * OpenObserve RUM/Logs SDKs expect. A real Error instance is always
 * forwarded as-is (never flattened first) so the SDK's own native
 * stack-trace handling can do its job; anything else is wrapped in a real
 * Error built from the bounded, sanitized message so the SDK still receives
 * a native error object instead of an arbitrary host-supplied value.
 */
export function mapError(error, context) {
  const safeContext = sanitizeAttributes(context);
  if (error instanceof Error) {
    return Object.freeze({ error, context: safeContext });
  }
  const sanitized = sanitizeError(error);
  return Object.freeze({ error: new Error(sanitized.message), context: safeContext });
}
