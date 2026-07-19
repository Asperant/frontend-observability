import { sanitizeError as sanitizeErrorResult } from "./sanitizers/error.js";

/**
 * Normalizes any value passed to recordError() into a bounded, plain
 * object. Never throws, regardless of the shape of `error`.
 */
export function sanitizeError(error) {
  const result = sanitizeErrorResult(error);
  return result.value?.error ?? Object.freeze({ name: "UnknownError", message: "Unknown error" });
}
