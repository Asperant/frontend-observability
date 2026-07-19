export function createUnavailableAdapter() {
  return Object.freeze({
    name: "unavailable",
    initialize() {
      return { ok: false };
    },
    setTrackingConsent() {
      return { ok: false };
    },
    recordAction() {
      return { ok: false };
    },
    recordError() {
      return { ok: false };
    },
    startSessionReplay() {
      return { ok: false };
    },
    stopSessionReplay() {
      return { ok: false };
    },
    shutdown() {
      return { ok: true };
    },
    getCapabilities() {
      return Object.freeze({ telemetry: false, sessionReplay: false });
    },
  });
}
