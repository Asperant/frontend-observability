import { STATUS } from "../internal/constants.js";
import { getState } from "../internal/state.js";
import { recordDiagnostic } from "../diagnostics/record-diagnostic.js";
import { normalizeOptions } from "../config/normalize-options.js";
import { validateOptions } from "../config/validate-options.js";

export function initializeObservability(options) {
  const state = getState();

  if (state.status === STATUS.READY || state.status === STATUS.INITIALIZING) {
    recordDiagnostic(
      "warn",
      "init.duplicate",
      "initializeObservability() was called while already initialized; ignoring.",
    );
    return { ok: false, reason: "already_initialized" };
  }

  const validation = validateOptions(options);
  if (!validation.valid) {
    state.status = STATUS.ERROR;
    state.lastError = validation.errors.join("; ");
    recordDiagnostic("error", "init.invalid_options", state.lastError);
    return { ok: false, reason: "invalid_options", errors: validation.errors };
  }

  state.status = STATUS.INITIALIZING;
  state.config = normalizeOptions(options);
  state.initializedAt = new Date().toISOString();
  state.lastError = null;
  state.status = STATUS.READY;

  recordDiagnostic("info", "init.complete", "Observability package initialized.", {
    applicationId: state.config.applicationId,
    privacyProfile: state.config.privacyProfile,
  });

  return { ok: true };
}
