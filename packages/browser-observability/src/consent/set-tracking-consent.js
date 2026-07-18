import { CONSENT } from "../internal/constants.js";
import { getState } from "../internal/state.js";
import { recordDiagnostic } from "../diagnostics/record-diagnostic.js";

const VALID_CONSENT_VALUES = new Set(Object.values(CONSENT));

export function setTrackingConsent(consent) {
  if (!VALID_CONSENT_VALUES.has(consent)) {
    recordDiagnostic("warn", "consent.invalid_value", "Ignored invalid consent value.", {
      received: typeof consent === "string" ? consent.slice(0, 32) : typeof consent,
    });
    return { ok: false, reason: "invalid_consent_value" };
  }

  const state = getState();
  state.consent = consent;
  recordDiagnostic("info", "consent.updated", "Tracking consent updated.", { consent });

  return { ok: true };
}
