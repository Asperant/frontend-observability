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
  });
}

export const UNAVAILABLE_CAPABILITIES = createCapabilities({
  telemetry: false,
  logs: false,
  sessionReplay: false,
});
