import { CONTROL_ENDPOINT_PATH } from "../../runtime-control/constants.js";

export const SANITIZATION_POLICY_VERSION = "telemetry-sanitization-v1";

export const PLACEHOLDERS = Object.freeze({
  email: "[REDACTED_EMAIL]",
  phone: "[REDACTED_PHONE]",
  iban: "[REDACTED_IBAN]",
  card: "[REDACTED_CARD]",
  uuid: "[REDACTED_UUID]",
  identifier: "[REDACTED_ID]",
  token: "[REDACTED_TOKEN]",
  secret: "[REDACTED_SECRET]",
});

export const SENSITIVE_ROUTE_PLACEHOLDER = "__sensitive__";

export const FORBIDDEN_URL_SCHEMES = Object.freeze(["data:", "blob:", "javascript:", "file:"]);

export const DEFAULT_SENSITIVE_ROUTES = Object.freeze([
  "/login",
  "/auth",
  "/password",
  "/reset-password",
  "/payment",
  "/checkout",
  "/card",
  "/identity",
  "/kyc",
  "/document",
  "/upload",
]);

export const OBSERVABILITY_RESOURCE_PATHS = Object.freeze([
  "/rum/v1/default/rum",
  "/rum/v1/default/logs",
  "/observability/config.json",
  CONTROL_ENDPOINT_PATH,
]);

export const FORBIDDEN_KEY_CATEGORIES = Object.freeze([
  "password",
  "secret",
  "token",
  "authorization",
  "cookie",
  "session",
  "csrf",
  "body",
  "payload",
  "request",
  "response",
  "header",
  "card",
  "cvv",
  "pin",
  "iban",
  "email",
  "phone",
  "address",
]);

export function buildSanitizationPolicy(runtimePolicy) {
  const sensitiveRoutes = safeStringArray(runtimePolicy?.excludedRoutes)
    .filter((route) => route.startsWith("/"))
    .map((route) => route.toLowerCase());
  return Object.freeze({
    version: SANITIZATION_POLICY_VERSION,
    sensitiveRoutes: Object.freeze([...new Set([...DEFAULT_SENSITIVE_ROUTES, ...sensitiveRoutes])]),
    observabilityResourcePaths: OBSERVABILITY_RESOURCE_PATHS,
  });
}

function safeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
