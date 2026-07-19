import { getRuntimeOrigin } from "../internal/environment.js";

export const DEFAULT_CONFIG_URL = "/observability/config.json";
const MAX_CONFIG_URL_LENGTH = 256;
const VALID_ENVIRONMENTS = Object.freeze(["development", "test", "staging", "production", "lab"]);
const OPTION_KEYS = Object.freeze(["configUrl", "service", "environment", "version"]);
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return { valid: false, errors: ["options must be a plain object"] };
  }

  const errors = [];
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) errors.push(`unknown option: ${key}`);
  }

  const configUrl = options.configUrl ?? DEFAULT_CONFIG_URL;
  const configUrlResult = validateConfigUrl(configUrl);
  if (!configUrlResult.valid) errors.push(...configUrlResult.errors);

  if (typeof options.service !== "string") {
    errors.push("service is required and must be a string");
  } else {
    const service = options.service.trim();
    if (service.length < 2 || service.length > 64) {
      errors.push("service must be 2-64 characters");
    }
    if (!SERVICE_PATTERN.test(service)) {
      errors.push("service may contain only lowercase letters, numbers, and hyphens");
    }
    if (UUID_PATTERN.test(service)) {
      errors.push("service must not be a UUID");
    }
  }

  if (!VALID_ENVIRONMENTS.includes(options.environment)) {
    errors.push(`environment must be one of: ${VALID_ENVIRONMENTS.join(", ")}`);
  }

  if (typeof options.version !== "string" || options.version.trim().length === 0) {
    errors.push("version is required and must be a non-empty string");
  } else if (options.version.length > 64) {
    errors.push("version must not exceed 64 characters");
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeOptions(options) {
  const configUrl = options.configUrl ?? DEFAULT_CONFIG_URL;
  const parsedUrl = new URL(configUrl, getRuntimeOrigin());
  const normalizedConfigUrl =
    parsedUrl.origin === getRuntimeOrigin() ? parsedUrl.pathname : parsedUrl.href;

  return Object.freeze({
    configUrl: normalizedConfigUrl,
    service: options.service.trim(),
    environment: options.environment,
    version: options.version.trim(),
  });
}

export function validateConfigUrl(configUrl) {
  const errors = [];
  if (typeof configUrl !== "string" || configUrl.trim().length === 0) {
    return { valid: false, errors: ["configUrl must be a non-empty string"] };
  }
  if (configUrl.length > MAX_CONFIG_URL_LENGTH) {
    errors.push(`configUrl must not exceed ${MAX_CONFIG_URL_LENGTH} characters`);
  }
  const lower = configUrl.trim().toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("file:")) {
    errors.push("configUrl scheme is not allowed");
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(configUrl, getRuntimeOrigin());
  } catch {
    errors.push("configUrl must be a valid URL");
  }
  if (parsedUrl) {
    if (parsedUrl.search || parsedUrl.hash) {
      errors.push("configUrl must not contain query or fragment");
    }
    if (parsedUrl.origin !== getRuntimeOrigin()) {
      errors.push("configUrl must be relative or same-origin");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      errors.push("configUrl protocol is not allowed");
    }
  }
  return { valid: errors.length === 0, errors };
}
