import { PRIVACY_PROFILES } from "../internal/constants.js";
import { isPrivacyBaselineIntact } from "../privacy/privacy-baseline.js";

const MAX_APPLICATION_ID_LENGTH = 128;

export function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return { valid: false, errors: ["options must be a plain object"] };
  }

  const errors = [];

  if (typeof options.applicationId !== "string" || options.applicationId.trim().length === 0) {
    errors.push("applicationId is required and must be a non-empty string");
  } else if (options.applicationId.length > MAX_APPLICATION_ID_LENGTH) {
    errors.push(`applicationId must not exceed ${MAX_APPLICATION_ID_LENGTH} characters`);
  }

  if (options.privacyProfile !== undefined && !PRIVACY_PROFILES.includes(options.privacyProfile)) {
    errors.push(`privacyProfile must be one of: ${PRIVACY_PROFILES.join(", ")}`);
  }

  if (!isPrivacyBaselineIntact(options)) {
    errors.push("options attempt to weaken the fixed privacy baseline");
  }

  return { valid: errors.length === 0, errors };
}
