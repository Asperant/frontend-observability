const SAMPLE_RATE_SCALE = 100;

/**
 * Builds the exact LogsInitConfiguration object passed to the real SDK's
 * `init()`. Automatic forwarding (console logs, uncaught errors/rejections,
 * Reporting API) is explicitly disabled: this package's own window
 * "error"/"unhandledrejection" listeners (in the host app) already call
 * recordError() manually, which this adapter forwards through RUM's
 * addError() when available. Leaving forwardErrorsToLogs at its SDK default
 * (true) would make the Logs SDK independently re-capture and re-send the
 * same uncaught error/rejection, sending it twice.
 */
export function buildLogsOptions(identity, policy, beforeSend) {
  const { service, environment, version } = identity;
  const { site, organizationIdentifier, clientToken, apiVersion } = policy.rum;

  return Object.freeze({
    clientToken,
    site,
    service,
    env: environment,
    version,
    apiVersion,
    organizationIdentifier,
    insecureHTTP: false,
    beforeSend,

    trackingConsent: "not-granted",
    telemetrySampleRate: 0,
    telemetryConfigurationSampleRate: 0,
    telemetryUsageSampleRate: 0,

    forwardErrorsToLogs: false,
    forwardConsoleLogs: undefined,
    forwardReports: undefined,
    usePciIntake: false,

    sessionSampleRate: clampRate(policy.sampling.sessionSampleRate) * SAMPLE_RATE_SCALE,

    silentMultipleInit: true,
    allowUntrustedEvents: false,
    storeContextsAcrossPages: false,
    trackSessionAcrossSubdomains: false,
    trackAnonymousUser: false,
    usePartitionedCrossSiteSessionCookie: false,
    // See build-rum-options.js: left at the SDK's own default (false) so a
    // plain-http:// host page (e.g. local dev) can still create a session
    // at all — a Secure-flagged cookie can never be set there, and the SDK
    // silently sends nothing when it can't create a session.
  });
}

function clampRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}
