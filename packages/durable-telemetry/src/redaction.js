const SECRET_KEY_PATTERN =
  /(^|[_-])(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|jwt)([_-]|$)/i;
const UNSAFE_FIELD_PATTERN =
  /(^|[_-])(headers?|request|response|body|payload|form|forms|dom|document|html|input|textarea|cookie|authorization|replay|segment|video|rrweb|snapshot|user|usr|account|email|phone|ip|client_ip|remote_addr)([_-]|$)/i;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/i,
  /\b(?:token|secret|password|api[_-]?key)=\S{6,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
]);
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6_PATTERN = /\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/gi;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 80;
const MAX_STRING_LENGTH = 4096;
const SAFE_MEASUREMENT_KEYS = new Set([
  "decoded_body_size",
  "document_version",
  "dom_complete",
  "dom_content_loaded",
  "dom_interactive",
  "encoded_body_size",
  "first_input_delay",
  "first_input_time",
  "first_input_target_selector",
]);
const DROP_TELEMETRY_KEYS = new Set([
  "beta_encode_cookie_options",
  "replay_level",
  "sampled_for_replay",
  "session_replay_sample_rate",
  "start_session_replay_recording_manually",
  "user_action",
]);

export class SanitizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "SanitizationError";
    this.code = code;
  }
}

export function sanitizeBrowserBatch(payload, { signal }) {
  const events = normalizeBatch(payload);
  return events.map((event) => sanitizeNode(event, { signal, path: [], depth: 0 }));
}

export function containsUnsafeTelemetryText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return false;
  return (
    SECRET_VALUE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    }) ||
    /"?(authorization|cookie|password|private[_-]?key|request[_-]?body|response[_-]?body|replay|segment|video|rrweb)"?\s*:/i.test(
      text,
    )
  );
}

function normalizeBatch(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return [payload];
  throw new SanitizationError("payload_not_object_or_array");
}

function sanitizeNode(value, context) {
  if (context.depth > MAX_DEPTH) throw new SanitizationError("payload_too_deep");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SanitizationError("unsafe_number");
    return value;
  }
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new SanitizationError("array_too_large");
    return value.map((item) =>
      sanitizeNode(item, { ...context, depth: context.depth + 1, path: [...context.path, "[]"] }),
    );
  }
  if (!isPlainObject(value)) throw new SanitizationError("unsafe_object");

  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) throw new SanitizationError("object_too_large");

  const sanitized = {};
  for (const [key, child] of entries) {
    if (!isSafeKey(key)) throw new SanitizationError("unsafe_key");
    if (DROP_TELEMETRY_KEYS.has(key)) continue;
    if (shouldRejectKey(key)) throw new SanitizationError(`unsafe_field:${key}`);
    if (shouldDropKey(key)) continue;

    const nextPath = [...context.path, key];
    sanitized[key] = sanitizeNode(child, {
      ...context,
      depth: context.depth + 1,
      path: nextPath,
    });
  }

  if (context.path.length === 0) enforceSignalShape(sanitized, context.signal);
  return sanitized;
}

function enforceSignalShape(event, signal) {
  if (signal === "rum") {
    const allowedTypes = new Set(["view", "action", "resource", "error", "long_task", "vital"]);
    if (typeof event.type !== "string" || !allowedTypes.has(event.type)) {
      throw new SanitizationError("unknown_rum_type");
    }
  }
  if (signal === "logs") {
    if (typeof event.message !== "string" && typeof event.status !== "string") {
      throw new SanitizationError("unknown_log_shape");
    }
  }
}

function sanitizeString(input) {
  const stripped = stripQueryAndFragment(input);
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(stripped))) {
    throw new SanitizationError("secret_detected");
  }
  let value = stripped.slice(0, MAX_STRING_LENGTH);
  value = value.replace(IPV4_PATTERN, "[REDACTED_IP]");
  value = value.replace(IPV6_PATTERN, "[REDACTED_IP]");
  return value;
}

function stripQueryAndFragment(value) {
  return value
    .replace(/https?:\/\/[^\s?#]+[^\s]*/gi, (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/(^|\s)(\/[^\s?#]*)[?#][^\s]*/g, "$1$2");
}

function shouldDropKey(key) {
  return DROP_TELEMETRY_KEYS.has(key) || SECRET_KEY_PATTERN.test(key);
}

function shouldRejectKey(key) {
  if (SAFE_MEASUREMENT_KEYS.has(key)) return false;
  return UNSAFE_FIELD_PATTERN.test(key);
}

function isSafeKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9_.-]{1,96}$/.test(key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
