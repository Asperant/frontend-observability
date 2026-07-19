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
      errorSampleRate: Math.min(
        PLATFORM_PRIVACY_BASELINE.sampling.errorSampleRate,
        config.sampling.errorSampleRate,
      ),
    }),
    rum: Object.freeze({ ...config.rum }),
    browserLogs: Object.freeze({ enabled: enabled && Boolean(config.browserLogs?.enabled) }),
    sessionReplay: Object.freeze({ enabled: false }),
    excludedRoutes: Object.freeze([...new Set(config.allowedRoutes)]),
    maskedSelectors: Object.freeze([...new Set(config.allowedSelectors)]),
    blockedSelectors: Object.freeze([...new Set(config.allowedSelectors)]),
  });
}
