export const PLATFORM_PRIVACY_BASELINE = Object.freeze({
  telemetryEnabled: true,
  captureBodies: false,
  captureCookies: false,
  captureHeaders: false,
  privacyMode: "strict",
  sampling: Object.freeze({ sessionSampleRate: 1, errorSampleRate: 1 }),
  sessionReplay: Object.freeze({ enabled: false }),
  browserLogs: Object.freeze({ enabled: false }),
  excludedRoutes: Object.freeze([]),
  maskedSelectors: Object.freeze([]),
  blockedSelectors: Object.freeze([]),
});

export function mergePrivacyPolicy(identity, config) {
  const enabled = config.enabled && !config.killSwitch?.engaged;
  // sensitiveRoutes is the canonical field name; allowedRoutes is a
  // deprecated legacy alias kept for backward compatibility (load-config.js
  // already enforces that exactly one of the two is present on the wire).
  const sensitiveRoutes = config.sensitiveRoutes ?? config.allowedRoutes ?? [];
  // allowedSelectors is a deprecated no-op now that Session Replay is
  // disabled; it may be absent from a canonical config entirely.
  const selectors = config.allowedSelectors ?? [];
  return Object.freeze({
    ...PLATFORM_PRIVACY_BASELINE,
    service: identity.service,
    environment: identity.environment,
    version: identity.version,
    telemetryEnabled: enabled,
    privacyMode: "strict",
    sampling: Object.freeze({
      sessionSampleRate: Math.min(
        PLATFORM_PRIVACY_BASELINE.sampling.sessionSampleRate,
        config.sampling.sessionSampleRate,
      ),
      // errorSampleRate is a deprecated no-op: the adapter never applies a
      // separate error sample rate (only sessionSampleRate is forwarded, see
      // adapter/openobserve/build-rum-options.js and build-logs-options.js).
      // Kept here only so a legacy config's value round-trips harmlessly
      // through status/diagnostics snapshots instead of vanishing silently.
      errorSampleRate: Math.min(
        PLATFORM_PRIVACY_BASELINE.sampling.errorSampleRate,
        config.sampling.errorSampleRate ?? PLATFORM_PRIVACY_BASELINE.sampling.errorSampleRate,
      ),
    }),
    rum: Object.freeze({ ...config.rum }),
    browserLogs: Object.freeze({ enabled: enabled && Boolean(config.browserLogs?.enabled) }),
    sessionReplay: Object.freeze({ enabled: false }),
    excludedRoutes: Object.freeze([...new Set(sensitiveRoutes)]),
    maskedSelectors: Object.freeze([...new Set(selectors)]),
    blockedSelectors: Object.freeze([...new Set(selectors)]),
  });
}
