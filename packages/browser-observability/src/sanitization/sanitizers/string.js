import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { accept, drop, redact } from "../diagnostics/results.js";
import { byteLength, truncateByChars } from "../limits/limits.js";
import { redactSensitiveText } from "../detectors/sensitive-values.js";

export function sanitizeString(value, { maxLength = 128, dropSecrets = true } = {}) {
  try {
    if (typeof value !== "string") return accept(value);
    const stripped = stripUrlQueryAndFragment(value);
    const redacted = redactSensitiveText(stripped);
    if (redacted.drop && dropSecrets) return drop(ReasonCodes.SECRET_DETECTED);
    const text = truncateByChars(redacted.drop ? "" : redacted.text, maxLength);
    const reasons = [...redacted.reasons];
    if (stripped !== value) reasons.push(ReasonCodes.PII_REDACTED);
    if (byteLength(value) > byteLength(text)) reasons.push(ReasonCodes.PAYLOAD_TOO_LARGE);
    return reasons.length > 0 ? redact(text, [...new Set(reasons)]) : accept(text);
  } catch {
    /* v8 ignore next -- defensive fail-closed guard for unexpected host runtime faults */
    return drop(ReasonCodes.SANITIZER_FAILURE);
  }
}

export function stripUrlQueryAndFragment(value) {
  return String(value)
    .replace(/https?:\/\/[^\s?#]+[^\s]*/gi, (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/(^|\s)(\/[^\s?#]+)[?#][^\s]*/g, "$1$2");
}
