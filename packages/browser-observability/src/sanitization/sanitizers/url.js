import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { ASSET_HASH_PATTERN, BASE64_TOKEN_PATTERN, UUID_PATTERN } from "../detectors/patterns.js";
import { accept, drop, redact } from "../diagnostics/results.js";
import { byteLength } from "../limits/limits.js";
import {
  FORBIDDEN_URL_SCHEMES,
  SENSITIVE_ROUTE_PLACEHOLDER,
  buildSanitizationPolicy,
} from "../policy/baseline.js";

export function sanitizeUrl(value, options = {}) {
  try {
    if (typeof value !== "string" || value.length === 0) return drop(ReasonCodes.URL_INVALID);
    if (byteLength(value) > 1024) return drop(ReasonCodes.PAYLOAD_TOO_LARGE);

    const base = safeBaseUrl(options.baseUrl);
    const parsed = new URL(value, base);
    if (FORBIDDEN_URL_SCHEMES.includes(parsed.protocol)) {
      return drop(ReasonCodes.URL_SCHEME_FORBIDDEN);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return drop(ReasonCodes.URL_SCHEME_FORBIDDEN);
    }

    const policy = buildSanitizationPolicy(options.policy);
    const rawPathname = parsed.pathname;
    let pathname;
    try {
      pathname = normalizePath(decodeURI(rawPathname));
    } catch {
      return drop(ReasonCodes.URL_INVALID);
    }

    if (options.resource && policy.observabilityResourcePaths.includes(pathname)) {
      return drop(ReasonCodes.URL_INVALID);
    }

    const reasons = [];
    if (isSensitiveRoute(pathname, policy.sensitiveRoutes)) {
      pathname = `/${SENSITIVE_ROUTE_PLACEHOLDER}`;
      reasons.push(ReasonCodes.SENSITIVE_ROUTE_REDACTED);
    } else {
      const normalized = normalizeSegments(pathname);
      if (normalized !== pathname) reasons.push(ReasonCodes.PII_REDACTED);
      pathname = normalized;
    }

    if (parsed.search || parsed.hash || parsed.username || parsed.password) {
      reasons.push(ReasonCodes.PII_REDACTED);
    }

    const sameOrigin = parsed.origin === new URL(base).origin;
    const sanitized = sameOrigin ? pathname : `${parsed.origin}${pathname}`;
    return reasons.length > 0 ? redact(sanitized, [...new Set(reasons)]) : accept(sanitized);
  } catch {
    return drop(ReasonCodes.URL_INVALID);
  }
}

function safeBaseUrl(baseUrl) {
  if (typeof baseUrl === "string" && baseUrl.length > 0) return baseUrl;
  const location = globalThis.location;
  /* v8 ignore if -- browser/jsdom runtimes expose location; fallback is for non-browser import safety */
  if (location?.href) return location.href;
  /* v8 ignore next -- fallback is for non-browser import safety */
  return "https://local.invalid/";
}

function normalizePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  return `/${parts.join("/")}`;
}

function normalizeSegments(pathname) {
  return pathname
    .split("/")
    .map((segment) => sanitizeSegment(segment))
    .join("/");
}

function sanitizeSegment(segment) {
  if (segment === "") return "";
  if (/^\d{9,}$/.test(segment)) return ":id";
  if (matches(UUID_PATTERN, segment)) return ":uuid";
  if (looksLikeAssetHash(segment)) return segment.replace(ASSET_HASH_PATTERN, ":hash");
  if (matches(BASE64_TOKEN_PATTERN, segment) || /^[A-Za-z0-9_-]{24,}$/.test(segment))
    return ":opaque";
  return encodeURIComponent(segment).replace(/%2F/gi, "/");
}

function looksLikeAssetHash(segment) {
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return matches(ASSET_HASH_PATTERN, segment);
  const name = segment.slice(0, dot);
  return /[.-][A-Fa-f0-9]{8,64}$/.test(name);
}

function isSensitiveRoute(pathname, sensitiveRoutes) {
  const normalized = pathname.toLowerCase();
  return sensitiveRoutes.some(
    (route) => normalized === route || normalized.startsWith(`${route}/`),
  );
}

function matches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
