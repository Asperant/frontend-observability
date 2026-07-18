import { CONSENT, STATUS } from "../internal/constants.js";
import { getState } from "../internal/state.js";
import { recordDiagnostic } from "../diagnostics/record-diagnostic.js";
import { sanitizeAttributes } from "../sanitization/sanitize-attributes.js";
import { sanitizeError } from "../sanitization/sanitize-error.js";

export function recordError(error, context) {
  const state = getState();

  if (state.status !== STATUS.READY) {
    return { ok: false, reason: "not_ready" };
  }
  if (state.consent !== CONSENT.GRANTED) {
    return { ok: false, reason: "consent_not_granted" };
  }

  const sanitized = sanitizeError(error);
  const sanitizedContext = sanitizeAttributes(context);

  recordDiagnostic("error", "error.recorded", sanitized.message, {
    name: sanitized.name,
    ...sanitizedContext,
  });

  return { ok: true };
}
