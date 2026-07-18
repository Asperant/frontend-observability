import { CONSENT, STATUS } from "../internal/constants.js";
import { getState } from "../internal/state.js";
import { recordDiagnostic } from "../diagnostics/record-diagnostic.js";
import { sanitizeAttributes } from "../sanitization/sanitize-attributes.js";
import { isValidActionName } from "./validate-action-name.js";

export function recordAction(name, attributes) {
  const state = getState();

  if (state.status !== STATUS.READY) {
    return { ok: false, reason: "not_ready" };
  }
  if (state.consent !== CONSENT.GRANTED) {
    return { ok: false, reason: "consent_not_granted" };
  }
  if (!isValidActionName(name)) {
    recordDiagnostic("warn", "action.invalid_name", "Ignored action with an invalid name.", {
      received: typeof name === "string" ? name.slice(0, 64) : typeof name,
    });
    return { ok: false, reason: "invalid_action_name" };
  }

  const sanitizedAttributes = sanitizeAttributes(attributes);
  recordDiagnostic("info", "action.recorded", name, sanitizedAttributes);

  return { ok: true };
}
