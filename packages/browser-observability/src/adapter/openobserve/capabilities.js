// Declares how this adapter's initialize()/shutdown() relate to the real
// vendor SDK: the SDK is a page-global singleton with no destroy/dispose
// API, so shutdown never tears it down and a later reinitialize resumes the
// same SDK instance rather than creating a new one. This is a fixed,
// structural property of this adapter (not a per-call outcome), so it is
// always reported the same way.
const LIFECYCLE_MODEL = "singleton-resume";

/**
 * Generic (adapter-agnostic) capability flags read by
 * bootstrap/coordinator.js to decide between an active and a degraded
 * runtime state. `telemetry` means the primary RUM channel (actions/errors)
 * is up; `logs` means the secondary browser-logs channel is up; session
 * replay is always false in this stage.
 */
export function createCapabilities({ telemetry, logs, sessionReplay = false }) {
  return Object.freeze({
    telemetry: Boolean(telemetry),
    logs: Boolean(logs),
    sessionReplay: Boolean(sessionReplay),
    lifecycleModel: LIFECYCLE_MODEL,
  });
}

export const UNAVAILABLE_CAPABILITIES = createCapabilities({
  telemetry: false,
  logs: false,
  sessionReplay: false,
});
