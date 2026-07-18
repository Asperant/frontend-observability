import { STATUS } from "../internal/constants.js";
import { getState, resetState } from "../internal/state.js";
import { recordDiagnostic } from "../diagnostics/record-diagnostic.js";

export function shutdownObservability() {
  const state = getState();

  if (state.status === STATUS.UNINITIALIZED || state.status === STATUS.SHUTDOWN) {
    return { ok: false, reason: "not_initialized" };
  }

  recordDiagnostic("info", "shutdown.complete", "Observability package shut down.");
  resetState();
  getState().status = STATUS.SHUTDOWN;

  return { ok: true };
}
