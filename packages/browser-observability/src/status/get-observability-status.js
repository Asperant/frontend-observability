import { getState } from "../internal/state.js";
import { getDiagnostics } from "../diagnostics/record-diagnostic.js";

export function getObservabilityStatus() {
  const state = getState();

  return Object.freeze({
    status: state.status,
    consent: state.consent,
    applicationId: state.config?.applicationId ?? null,
    privacyProfile: state.config?.privacyProfile ?? null,
    initializedAt: state.initializedAt,
    lastError: state.lastError,
    diagnosticsCount: getDiagnostics().length,
  });
}
