import { readFileSync } from "node:fs";

import { validateRuntimeConfig } from "../../packages/contracts/src/validators.js";
import { atomicWriteFile, runtimeConfigPath, rumClientTokenSecretPath } from "./common.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// Must match the ZO_RUM_* environment the openobserve service is given in
// compose.yaml, and the exact ingestion path the real SDK will build from
// them: https://{site}/rum/{apiVersion}/{organizationIdentifier}/{rum|logs}.
export const RUM_SITE = "localhost:8443";
export const RUM_ORGANIZATION_IDENTIFIER = "default";
export const RUM_APPLICATION_ID = "chicek-demo-frontend";
export const RUM_API_VERSION = "v1";

/**
 * Lab runtime config: real OpenObserve RUM + browser logs, enabled. Session
 * and error sampling are 100% — a deliberate lab-only relaxation (see the
 * platform privacy baseline in src/config/merge-policy.js, which still caps
 * both at 100% max) purely so Stage 8's browser/E2E and OpenObserve
 * integration tests are deterministic rather than flaky under partial
 * sampling. Session replay stays off; this schema version cannot express it
 * any other way.
 */
export function buildLabRuntimeConfig(now = new Date(), { rumClientToken }) {
  return {
    schemaVersion: "1.0.0",
    configVersion: "lab-stage8-enabled",
    enabled: true,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
    killSwitch: { engaged: false },
    privacyProfile: "strict",
    sampling: { sessionSampleRate: 1, errorSampleRate: 1 },
    rum: {
      site: RUM_SITE,
      organizationIdentifier: RUM_ORGANIZATION_IDENTIFIER,
      applicationId: RUM_APPLICATION_ID,
      clientToken: rumClientToken,
      apiVersion: RUM_API_VERSION,
    },
    browserLogs: { enabled: true },
    sessionReplay: { enabled: false },
    allowedRoutes: [],
    allowedSelectors: [],
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
