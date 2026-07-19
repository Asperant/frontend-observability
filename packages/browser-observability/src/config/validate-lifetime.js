import { ReasonCodes } from "../diagnostics/reason-codes.js";

export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export function validateLifetime(config, now = new Date()) {
  const issuedAtMs = Date.parse(config?.issuedAt);
  const expiresAtMs = Date.parse(config?.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    return { valid: false, reasonCode: ReasonCodes.CONFIG_SCHEMA_INVALID };
  }
  if (expiresAtMs <= issuedAtMs) {
    return { valid: false, reasonCode: ReasonCodes.CONFIG_SCHEMA_INVALID };
  }
  const nowMs = now.getTime();
  if (expiresAtMs <= nowMs) {
    return { valid: false, reasonCode: ReasonCodes.CONFIG_EXPIRED };
  }
  if (issuedAtMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return { valid: false, reasonCode: ReasonCodes.CONFIG_NOT_YET_VALID };
  }
  return { valid: true, reasonCode: ReasonCodes.NONE };
}
