import { containsSecret } from "../sanitization/detectors/sensitive-values.js";

const SAFE_ID_PATTERN = /^[\x20-\x7e]+$/;
const MAX_ID_LENGTH = 128;

export function validateCorrelationId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value) &&
    !containsSecret(value)
  );
}
