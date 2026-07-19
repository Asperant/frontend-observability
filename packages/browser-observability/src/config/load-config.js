import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { validateLifetime } from "./validate-lifetime.js";

export const CONFIG_FETCH_TIMEOUT_MS = 2000;
export const MAX_CONFIG_BODY_BYTES = 64 * 1024;

const CONFIG_KEYS = Object.freeze([
  "schemaVersion",
  "configVersion",
  "enabled",
  "issuedAt",
  "expiresAt",
  "killSwitch",
  "privacyProfile",
  "sampling",
  "rum",
  "browserLogs",
  "sessionReplay",
  "allowedRoutes",
  "allowedSelectors",
]);

export async function loadConfig(configUrl, { signal, now = new Date() } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);
  const abortOnParent = () => controller.abort();
  signal?.addEventListener("abort", abortOnParent, { once: true });

  try {
    const response = await globalThis.fetch(configUrl, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status !== 200 || response.redirected) {
      return { ok: false, reasonCode: ReasonCodes.CONFIG_HTTP_ERROR };
    }
    if (!isJsonContentType(response.headers?.get?.("content-type"))) {
      return { ok: false, reasonCode: ReasonCodes.CONFIG_CONTENT_TYPE_INVALID };
    }

    const bodyResult = await readBoundedBody(response);
    if (!bodyResult.ok) return bodyResult;

    let config;
    try {
      config = JSON.parse(bodyResult.body);
    } catch {
      return { ok: false, reasonCode: ReasonCodes.CONFIG_JSON_INVALID };
    }

    if (!validateRuntimeConfigShape(config)) {
      return { ok: false, reasonCode: ReasonCodes.CONFIG_SCHEMA_INVALID };
    }

    const lifetime = validateLifetime(config, now);
    if (!lifetime.valid) {
      return { ok: false, reasonCode: lifetime.reasonCode };
    }

    return { ok: true, config };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      return { ok: false, reasonCode: ReasonCodes.CONFIG_TIMEOUT };
    }
    if (error?.name === "AbortError") {
      return { ok: false, reasonCode: ReasonCodes.CONFIG_TIMEOUT };
    }
    return { ok: false, reasonCode: ReasonCodes.CONFIG_UNAVAILABLE };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortOnParent);
  }
}

export function isJsonContentType(contentType) {
  if (typeof contentType !== "string") return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

async function readBoundedBody(response) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CONFIG_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, reasonCode: ReasonCodes.CONFIG_TOO_LARGE };
      }
      chunks.push(value);
    }
    return { ok: true, body: new TextDecoder().decode(concatChunks(chunks, total)) };
  }

  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_CONFIG_BODY_BYTES) {
    return { ok: false, reasonCode: ReasonCodes.CONFIG_TOO_LARGE };
  }
  return { ok: true, body };
}

function concatChunks(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function validateRuntimeConfigShape(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return false;
  if (Object.keys(config).some((key) => !CONFIG_KEYS.includes(key))) return false;
  if (config.schemaVersion !== "1.0.0") return false;
  if (config.configVersion !== undefined && !isString(config.configVersion, 1, 64)) return false;
  if (typeof config.enabled !== "boolean") return false;
  if (!isString(config.issuedAt, 1, 64) || !isString(config.expiresAt, 1, 64)) return false;
  if (!isObject(config.killSwitch) || typeof config.killSwitch.engaged !== "boolean") return false;
  if (Object.keys(config.killSwitch).some((key) => !["engaged", "reason"].includes(key))) {
    return false;
  }
  if (config.killSwitch.reason !== undefined && !isString(config.killSwitch.reason, 0, 256)) {
    return false;
  }
  if (!["strict", "balanced"].includes(config.privacyProfile)) return false;
  if (!isSampling(config.sampling)) return false;
  if (!isRumConfig(config.rum, config.enabled)) return false;
  if (!isObject(config.browserLogs) || typeof config.browserLogs.enabled !== "boolean")
    return false;
  if (Object.keys(config.browserLogs).length !== 1) return false;
  if (!isObject(config.sessionReplay) || config.sessionReplay.enabled !== false) return false;
  if (Object.keys(config.sessionReplay).length !== 1) return false;
  if (!isStringArray(config.allowedRoutes, 100, 256)) return false;
  if (!isStringArray(config.allowedSelectors, 200, 256)) return false;
  return true;
}

function isSampling(value) {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => ["sessionSampleRate", "errorSampleRate"].includes(key)) &&
    isRate(value.sessionSampleRate) &&
    isRate(value.errorSampleRate)
  );
}

const RUM_SITE_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[0-9]{1,5})?$/;
const RUM_KEYS = Object.freeze([
  "site",
  "organizationIdentifier",
  "applicationId",
  "clientToken",
  "apiVersion",
]);

function isRumConfig(value, enabled) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !RUM_KEYS.includes(key))) return false;
  if (!enabled && keys.length === 0) return true;
  return (
    isString(value.site, 1, 256) &&
    RUM_SITE_PATTERN.test(value.site) &&
    isString(value.organizationIdentifier, 1, 128) &&
    isString(value.applicationId, 1, 128) &&
    isString(value.clientToken, 16, 256) &&
    value.apiVersion === "v1"
  );
}

function isStringArray(value, maxItems, maxLength) {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isString(item, 1, maxLength))
  );
}

function isRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isString(value, minLength, maxLength) {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
