import { AdmissionError } from "@frontend-observability/telemetry-delivery-core";

const CONTROL_SCHEMA_VERSION = 1;
const MAX_REASON_CODE_LENGTH = 64;
const CONTROL_REASON_CODES = Object.freeze([
  "none",
  "security_incident",
  "privacy_incident",
  "service_degradation",
  "maintenance",
  "operator_request",
]);

export function validateControlUrl(value) {
  try {
    new URL(value);
  } catch {
    throw new Error("invalid_environment_variable: OBSERVABILITY_CONTROL_URL");
  }
  return value;
}

export function validateControlDocument(document, now = new Date()) {
  if (!isPlainObject(document)) return { valid: false, reason: "runtime_control_invalid" };
  if (document.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    return { valid: false, reason: "runtime_control_invalid" };
  }
  if (!Number.isInteger(document.revision) || document.revision < 0) {
    return { valid: false, reason: "runtime_control_invalid" };
  }
  const issuedAt = Date.parse(document.issuedAt);
  const expiresAt = Date.parse(document.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: "runtime_control_invalid" };
  }
  if (expiresAt <= issuedAt) return { valid: false, reason: "runtime_control_invalid" };
  if (!isPlainObject(document.killSwitch)) {
    return { valid: false, reason: "runtime_control_invalid" };
  }
  if (typeof document.killSwitch.active !== "boolean") {
    return { valid: false, reason: "runtime_control_invalid" };
  }
  const reasonCode = document.killSwitch.reasonCode;
  if (
    typeof reasonCode !== "string" ||
    reasonCode.length === 0 ||
    reasonCode.length > MAX_REASON_CODE_LENGTH ||
    !CONTROL_REASON_CODES.includes(reasonCode)
  ) {
    return { valid: false, reason: "runtime_control_invalid" };
  }
  if (expiresAt <= now.getTime()) return { valid: false, reason: "runtime_control_expired" };
  return { valid: true };
}

export function createRuntimeControlGuard({ url, timeoutMs }) {
  return async function assertRuntimeControlOpen(scope) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Observability-Service": scope.service,
          "X-Observability-Environment": scope.environment,
        },
        signal: controller.signal,
      });
    } catch {
      throw new AdmissionError(503, "runtime_control_unavailable");
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200) throw new AdmissionError(503, "runtime_control_unavailable");
    let document;
    try {
      document = await response.json();
    } catch {
      throw new AdmissionError(503, "runtime_control_invalid");
    }
    const validation = validateControlDocument(document);
    if (!validation.valid) throw new AdmissionError(503, validation.reason);
    if (document.killSwitch.active === true) {
      throw new AdmissionError(503, "runtime_control_disabled");
    }
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
