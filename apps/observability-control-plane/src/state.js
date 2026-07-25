import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  appendAudit,
  atomicWriteText,
  buildControlDocument,
  readJson,
  readText,
  sha256,
  statePaths,
  tryReadJson,
  validateControlDocument,
  validateRuntimeConfigText,
} from "./io.js";

export function createControlPlaneState(stateDir) {
  const paths = statePaths(stateDir);

  function status(now = new Date(), scope) {
    const normalizedScope = normalizeScope(scope);
    const config = validateActiveConfig(now, normalizedScope);
    const control = validateActiveControl(now, normalizedScope);
    return {
      ready: config.ready && control.ready,
      config,
      control,
    };
  }

  function getActiveConfig(scope) {
    return readText(configPathForScope(normalizeScope(scope)));
  }

  function getActiveControl(scope) {
    return `${JSON.stringify(resolveControlDocument(normalizeScope(scope)), null, 2)}\n`;
  }

  function publishConfig(text, { actor = "operator", scope } = {}) {
    const normalizedScope = normalizeScope(scope);
    const validation = validateRuntimeConfigText(text);
    if (!validation.valid) {
      appendAudit(paths, {
        action: "runtime_config_publish_rejected",
        actor,
        scope: auditScope(normalizedScope),
        reason: validation.reason,
      });
      return { ok: false, reason: validation.reason, errors: validation.errors ?? [] };
    }
    const hash = sha256(text);
    const history = readHistory();
    const revision = (history.at(-1)?.revision ?? 0) + 1;
    atomicWriteText(
      configPathForScope(normalizedScope, { forWrite: true }),
      `${JSON.stringify(validation.document, null, 2)}\n`,
      0o644,
    );
    const nextHistory = [
      ...history,
      {
        revision,
        scope: auditScope(normalizedScope),
        configVersion: validation.document.configVersion ?? null,
        hash,
        publishedAt: new Date().toISOString(),
      },
    ].slice(-100);
    atomicWriteText(paths.configHistory, `${JSON.stringify(nextHistory, null, 2)}\n`, 0o600);
    appendAudit(paths, {
      action: "runtime_config_published",
      actor,
      revision,
      scope: auditScope(normalizedScope),
      hash,
    });
    return { ok: true, revision, hash };
  }

  function publishControl({
    active,
    reasonCode = "operator_request",
    actor = "operator",
    scope,
  } = {}) {
    const normalizedScope = normalizeScope(scope);
    const previousRevision = maxControlRevision();
    const document = buildControlDocument({ active, reasonCode, previousRevision });
    const validation = validateControlDocument(document, new Date(), previousRevision);
    if (!validation.valid) {
      appendAudit(paths, {
        action: "runtime_control_publish_rejected",
        actor,
        scope: auditScope(normalizedScope),
        reason: validation.reason,
      });
      return { ok: false, reason: validation.reason };
    }
    atomicWriteText(
      controlPathForScope(normalizedScope, { forWrite: true }),
      `${JSON.stringify(document, null, 2)}\n`,
      0o644,
    );
    appendAudit(paths, {
      action: "runtime_control_published",
      actor,
      revision: document.revision,
      scope: auditScope(normalizedScope),
      active: document.killSwitch.active,
      reasonCode: document.killSwitch.reasonCode,
    });
    return { ok: true, document };
  }

  function history() {
    return readHistory();
  }

  function deliveryControlDocument(now = new Date()) {
    const global = readControlForDelivery(paths.activeControl, now);
    const scopedHolds = [];
    if (existsSync(paths.scopedControlsDir)) {
      for (const entry of readdirSync(paths.scopedControlsDir)) {
        if (!entry.endsWith(".json")) continue;
        const control = readControlForDelivery(join(paths.scopedControlsDir, entry), now);
        if (!control.ready || !control.document.killSwitch.active) continue;
        const scope = scopeFromKey(entry.slice(0, -".json".length));
        if (scope) scopedHolds.push(scope);
      }
    }
    return {
      schemaVersion: 1,
      hold: !global.ready || global.document.killSwitch.active || scopedHolds.length > 0,
      reason: !global.ready
        ? "runtime_control_unready"
        : global.document.killSwitch.active
          ? global.document.killSwitch.reasonCode
          : scopedHolds.length > 0
            ? "scoped_runtime_control_disabled"
            : "runtime_control_enabled",
      scopedHolds,
      updatedAt: new Date().toISOString(),
    };
  }

  function auditLines(limit = 50) {
    if (!existsSync(paths.audit)) return [];
    return readText(paths.audit).trim().split(/\n/).filter(Boolean).slice(-limit);
  }

  function validateActiveConfig(now, scope) {
    const path = configPathForScope(scope);
    if (!existsSync(path)) return { ready: false, reason: "missing" };
    const result = validateRuntimeConfigText(readText(path), now);
    if (!result.valid) return { ready: false, reason: result.reason };
    return {
      ready: true,
      scope: auditScope(scope),
      configVersion: result.document.configVersion ?? null,
      hash: sha256(readText(path)),
      expiresAt: result.document.expiresAt,
    };
  }

  function validateActiveControl(now, scope) {
    const path = controlPathForScope(scope);
    if (!existsSync(path)) return { ready: false, reason: "missing" };
    let document;
    try {
      document = resolveControlDocument(scope);
    } catch {
      return { ready: false, reason: "invalid_json" };
    }
    const validation = validateControlDocument(document, now, document.revision - 1);
    if (!validation.valid) return { ready: false, reason: validation.reason };
    return {
      ready: true,
      scope: auditScope(scope),
      revision: document.revision,
      active: document.killSwitch.active,
      reasonCode: document.killSwitch.reasonCode,
      expiresAt: document.expiresAt,
    };
  }

  function configPathForScope(scope, { forWrite = false } = {}) {
    if (!scope) return paths.activeConfig;
    const scopedPath = join(paths.scopedConfigsDir, `${scopeKey(scope)}.json`);
    return forWrite || existsSync(scopedPath) ? scopedPath : paths.activeConfig;
  }

  function controlPathForScope(scope, { forWrite = false } = {}) {
    if (!scope) return paths.activeControl;
    const scopedPath = join(paths.scopedControlsDir, `${scopeKey(scope)}.json`);
    return forWrite || existsSync(scopedPath) ? scopedPath : paths.activeControl;
  }

  function resolveControlDocument(scope) {
    const global = readJson(paths.activeControl);
    if (!scope) return global;
    const globalValidation = validateControlDocument(global, new Date(), global.revision - 1);
    if (!globalValidation.valid) return global;
    const scopedPath = join(paths.scopedControlsDir, `${scopeKey(scope)}.json`);
    if (!existsSync(scopedPath)) return global;
    const scoped = readJson(scopedPath);
    if (global.killSwitch.active) return global;
    if (scoped.killSwitch.active) return scoped;
    return scoped.revision >= global.revision ? scoped : global;
  }

  function maxControlRevision() {
    const revisions = [];
    const global = tryReadJson(paths.activeControl);
    if (Number.isInteger(global?.revision)) revisions.push(global.revision);
    if (existsSync(paths.scopedControlsDir)) {
      for (const entry of readdirSync(paths.scopedControlsDir)) {
        if (!entry.endsWith(".json")) continue;
        const scoped = tryReadJson(join(paths.scopedControlsDir, entry));
        if (Number.isInteger(scoped?.revision)) revisions.push(scoped.revision);
      }
    }
    return revisions.length > 0 ? Math.max(...revisions) : -1;
  }

  function readHistory() {
    const parsed = tryReadJson(paths.configHistory);
    return Array.isArray(parsed) ? parsed : [];
  }

  return Object.freeze({
    paths,
    auditLines,
    getActiveConfig,
    getActiveControl,
    history,
    publishConfig,
    publishControl,
    deliveryControlDocument,
    status,
  });
}

export function normalizeScope(scope) {
  if (scope === undefined || scope === null) return null;
  if (scope.service === undefined && scope.environment === undefined) return null;
  if (!isScopePart(scope.service) || !isScopePart(scope.environment)) {
    throw new Error("invalid_scope");
  }
  return Object.freeze({
    service: scope.service,
    environment: scope.environment,
  });
}

function auditScope(scope) {
  return scope ? `${scope.service}/${scope.environment}` : "global";
}

function scopeKey(scope) {
  return `${scope.service}__${scope.environment}`;
}

function scopeFromKey(key) {
  const [service, environment, ...rest] = key.split("__");
  if (rest.length > 0 || !isScopePart(service) || !isScopePart(environment)) return null;
  return { service, environment };
}

function isScopePart(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
}

function readControlForDelivery(path, now) {
  let document;
  try {
    document = readJson(path);
  } catch {
    return { ready: false, document: null };
  }
  const validation = validateControlDocument(document, now, document.revision - 1);
  return { ready: validation.valid, document };
}
