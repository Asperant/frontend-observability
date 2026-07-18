import { validateRuntimeConfig } from "../../packages/contracts/src/validators.js";
import { atomicWriteFile, runtimeConfigPath } from "./common.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stage 6 runtime config: observability stays fully disabled (no real RUM
 * endpoint exists yet), so the schema's now-conditional `rum` credential
 * fields are omitted entirely rather than filled with a fake token.
 */
export function buildStage6RuntimeConfig(now = new Date()) {
  return {
    schemaVersion: "1.0.0",
    enabled: false,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
    killSwitch: { engaged: true, reason: "stage-6-lab-observability-disabled" },
    privacyProfile: "strict",
    sampling: { sessionSampleRate: 0, errorSampleRate: 0 },
    rum: {},
    browserLogs: { enabled: false },
    sessionReplay: { enabled: false },
    allowedRoutes: [],
    allowedSelectors: [],
  };
}

export function generateRuntimeConfig() {
  const config = buildStage6RuntimeConfig();
  const result = validateRuntimeConfig(config);
  if (!result.valid) {
    throw new Error(
      `generated runtime config failed schema validation: ${result.errors.join("; ")}`,
    );
  }
  atomicWriteFile(runtimeConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  return config;
}
