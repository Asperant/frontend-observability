import { DEFAULT_OPTIONS } from "./defaults.js";

/**
 * Assumes `options` has already passed validate-options.js. Never widens
 * privacy-sensitive fields beyond DEFAULT_OPTIONS/PRIVACY_BASELINE.
 */
export function normalizeOptions(options) {
  return Object.freeze({
    ...DEFAULT_OPTIONS,
    ...options,
    applicationId: options.applicationId.trim(),
  });
}
