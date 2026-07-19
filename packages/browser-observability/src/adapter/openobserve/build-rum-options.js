const SAMPLE_RATE_SCALE = 100;

/**
 * Builds the exact RumInitConfiguration object passed to the real SDK's
 * `init()`. The mandatory security values below are fixed by this stage's
 * threat model and are never influenced by caller options or runtime
 * config: consent starts closed, privacy masks user input, session replay
 * is fully disabled (0% sample rate, manual-start-only, and this adapter
 * never calls startSessionReplayRecording()), transport is always HTTPS,
 * and no user/account identity is ever attached.
 */
export function buildRumOptions(identity, policy, beforeSend) {
  const { service, environment, version } = identity;
  const { site, organizationIdentifier, applicationId, clientToken, apiVersion } = policy.rum;

  return Object.freeze({
    applicationId,
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
    defaultPrivacyLevel: "mask-user-input",
    enablePrivacyForActionName: true,
    trackUserInteractions: true,
    actionNameAttribute: "data-chicek-action",
    sessionReplaySampleRate: 0,
    startSessionReplayRecordingManually: true,
    telemetrySampleRate: 0,
    telemetryConfigurationSampleRate: 0,
    telemetryUsageSampleRate: 0,

    sessionSampleRate: clampRate(policy.sampling.sessionSampleRate) * SAMPLE_RATE_SCALE,

    silentMultipleInit: true,
    allowUntrustedEvents: false,
    storeContextsAcrossPages: false,
    trackSessionAcrossSubdomains: false,
    trackAnonymousUser: false,
    usePartitionedCrossSiteSessionCookie: false,
    // Left at the SDK's own default (false): forcing a Secure-flagged
    // session cookie makes the SDK refuse to create a session — and
    // silently send nothing at all — on any plain-http:// origin (e.g.
    // local dev). insecureHTTP:false above already guarantees the SDK's
    // own network transport to OpenObserve is always HTTPS regardless of
    // the host page's own scheme; this setting is about the session cookie
    // only and isn't part of this stage's mandatory security baseline.
  });
}

function clampRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}
