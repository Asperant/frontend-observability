/**
 * Fixed, immutable privacy baseline. No caller-supplied option, runtime
 * config, or privacy profile is permitted to override these values in
 * this stage of the package.
 */
export const PRIVACY_BASELINE = Object.freeze({
  sessionReplayEnabled: false,
  collectRequestBodies: false,
  collectResponseBodies: false,
  collectCookies: false,
  collectAuthorizationHeaders: false,
});

/**
 * Returns true only if every baseline-controlled field on `candidate` is
 * either absent (defaults will apply) or matches the safe baseline value.
 * Any explicit attempt to flip a baseline field to an unsafe value fails.
 */
export function isPrivacyBaselineIntact(candidate) {
  if (candidate === null || typeof candidate !== "object") {
    return true;
  }
  return Object.entries(PRIVACY_BASELINE).every(([key, safeValue]) => {
    const value = candidate[key];
    return value === undefined || value === safeValue;
  });
}
