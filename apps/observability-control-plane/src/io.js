import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  hasDuplicateObjectKeys,
  validateRuntimeConfig,
} from "@frontend-observability/observability-contracts";

const CONTROL_SCHEMA_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_CONFIG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONTROL_TTL_MS = 10 * 60 * 1000;
const CONTROL_REASONS = Object.freeze([
  "none",
  "security_incident",
  "privacy_incident",
  "service_degradation",
  "maintenance",
  "operator_request",
]);

export function statePaths(stateDir) {
  return Object.freeze({
    stateDir,
    activeConfig: join(stateDir, "active-config.json"),
    activeControl: join(stateDir, "active-control.json"),
    scopedConfigsDir: join(stateDir, "scoped-configs"),
    scopedControlsDir: join(stateDir, "scoped-controls"),
    configHistory: join(stateDir, "config-history.json"),
    audit: join(stateDir, "audit.jsonl"),
  });
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function readJson(path) {
  const text = readText(path);
  if (hasDuplicateObjectKeys(text)) throw new Error("duplicate_json_key");
  return JSON.parse(text);
}

export function tryReadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

export function atomicWriteText(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tempDir = join(dirname(path), `.tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tempDir, { mode: 0o700 });
  const tempFile = join(tempDir, "write");
  let fd;
  try {
    fd = openSync(tempFile, "wx", mode);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempFile, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function appendAudit(paths, event) {
  const auditEvent = {
    at: new Date().toISOString(),
    ...event,
  };
  delete auditEvent.document;
  delete auditEvent.token;
  delete auditEvent.secret;
  mkdirSync(dirname(paths.audit), { recursive: true });
  const fd = openSync(paths.audit, "a", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(auditEvent)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function validateRuntimeConfigText(text, now = new Date()) {
  if (hasDuplicateObjectKeys(text)) return { valid: false, reason: "duplicate_json_key" };
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return { valid: false, reason: "invalid_json" };
  }
  const schema = validateRuntimeConfig(document);
  if (!schema.valid) return { valid: false, reason: "schema_invalid", errors: schema.errors };
  if (document.sessionReplay?.enabled !== false) return { valid: false, reason: "replay_enabled" };
  const lifetime = validateLifetime(document, now, MAX_CONFIG_TTL_MS);
  if (!lifetime.valid) return lifetime;
  return { valid: true, document };
}

export function validateControlDocument(document, now = new Date(), previousRevision = -1) {
  if (!isPlainObject(document)) return { valid: false, reason: "schema_invalid" };
  if (
    !hasOnlyKeys(document, ["schemaVersion", "revision", "issuedAt", "expiresAt", "killSwitch"])
  ) {
    return { valid: false, reason: "unknown_key" };
  }
  if (document.schemaVersion !== CONTROL_SCHEMA_VERSION)
    return { valid: false, reason: "schema_invalid" };
  if (!Number.isInteger(document.revision) || document.revision < 0) {
    return { valid: false, reason: "revision_invalid" };
  }
  if (document.revision <= previousRevision)
    return { valid: false, reason: "revision_not_monotonic" };
  if (!isPlainObject(document.killSwitch)) return { valid: false, reason: "schema_invalid" };
  if (!hasOnlyKeys(document.killSwitch, ["active", "reasonCode"])) {
    return { valid: false, reason: "unknown_key" };
  }
  if (typeof document.killSwitch.active !== "boolean")
    return { valid: false, reason: "schema_invalid" };
  if (!CONTROL_REASONS.includes(document.killSwitch.reasonCode)) {
    return { valid: false, reason: "reason_invalid" };
  }
  return validateLifetime(document, now, MAX_CONTROL_TTL_MS);
}

export function buildControlDocument({
  active,
  reasonCode = "operator_request",
  previousRevision = -1,
  now = new Date(),
}) {
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    revision: previousRevision + 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MAX_CONTROL_TTL_MS).toISOString(),
    killSwitch: { active: Boolean(active), reasonCode: active ? reasonCode : "none" },
  };
}

function validateLifetime(document, now, maxTtlMs) {
  const issuedAt = Date.parse(document.issuedAt);
  const expiresAt = Date.parse(document.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: "lifetime_invalid" };
  }
  if (expiresAt <= issuedAt) return { valid: false, reason: "lifetime_invalid" };
  if (expiresAt - issuedAt > maxTtlMs) return { valid: false, reason: "ttl_exceeded" };
  const nowMs = now.getTime();
  if (issuedAt > nowMs + MAX_CLOCK_SKEW_MS) return { valid: false, reason: "not_yet_valid" };
  if (expiresAt <= nowMs) return { valid: false, reason: "expired" };
  return { valid: true };
}

function hasOnlyKeys(object, keys) {
  return Object.keys(object).every((key) => keys.includes(key));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fsyncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
