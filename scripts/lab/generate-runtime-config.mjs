import { readFileSync } from "node:fs";

import { validateRuntimeConfig } from "../../packages/observability-contracts/src/validators.js";
import { atomicWriteFile, runtimeConfigPath, rumClientTokenSecretPath } from "./common.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// Must match the exact ingestion path the real SDK will build and the
// reverse proxy allowlists: https://{site}/rum/{apiVersion}/{organizationIdentifier}/{rum|logs}.
// Do not mirror these values into OpenObserve's own ZO_RUM_* web-UI
// instrumentation env vars; the lab observes the demo app, not the
// OpenObserve admin UI.
export const RUM_SITE = "localhost:8443";
export const RUM_ORGANIZATION_IDENTIFIER = "default";
export const RUM_APPLICATION_ID = "chicek-browser-app";
export const RUM_API_VERSION = "v1";

/**
 * Lab runtime config: real OpenObserve RUM + browser logs, enabled. Session
 * sampling is 100% — a deliberate lab-only relaxation (see the platform
 * privacy baseline in src/config/merge-policy.js, which still caps it at
 * 100% max) purely so OpenObserve integration's browser/E2E and OpenObserve integration
 * tests are deterministic rather than flaky under partial sampling. Session
 * replay stays off; this schema version cannot express it any other way.
 *
 * Uses only the canonical company-facing fields (`sensitiveRoutes`,
 * `privacyProfile: "strict"`, `sampling.sessionSampleRate`). The deprecated
 * legacy aliases (`allowedRoutes`, `allowedSelectors`,
 * `sampling.errorSampleRate`, `privacyProfile: "balanced"`) still validate
 * for backward compatibility but must not appear in a newly authored
 * config — see packages/observability-contracts/schemas/runtime-config.schema.json.
 */
export function buildLabRuntimeConfig(now = new Date(), { rumClientToken }) {
  return {
    schemaVersion: "1.0.0",
    configVersion: "lab-runtime-enabled",
    enabled: true,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
    killSwitch: { engaged: false },
    privacyProfile: "strict",
    sampling: { sessionSampleRate: 1 },
    rum: {
      site: RUM_SITE,
      organizationIdentifier: RUM_ORGANIZATION_IDENTIFIER,
      applicationId: RUM_APPLICATION_ID,
      clientToken: rumClientToken,
      apiVersion: RUM_API_VERSION,
    },
    browserLogs: { enabled: true },
    sessionReplay: { enabled: false },
    sensitiveRoutes: [],
  };
}

export function generateRuntimeConfig() {
  const rumClientToken = readFileSync(rumClientTokenSecretPath, "utf8").trim();
  const config = buildLabRuntimeConfig(new Date(), { rumClientToken });
  const result = validateRuntimeConfig(config);
  if (!result.valid) {
    throw new Error(
      `generated runtime config failed schema validation: ${result.errors.join("; ")}`,
    );
  }
  atomicWriteFile(runtimeConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  return config;
}
