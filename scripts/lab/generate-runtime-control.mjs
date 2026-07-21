import { existsSync, readFileSync } from "node:fs";

import {
  validateControlDocumentShape,
  validateControlLifetime,
} from "../../packages/browser-observability/src/runtime-control/validate-document.js";
import {
  CONTROL_SCHEMA_VERSION,
  MAX_CONTROL_TTL_MS,
} from "../../packages/browser-observability/src/runtime-control/constants.js";
import { atomicWriteFile, runtimeControlPath } from "./common.mjs";

export function readCurrentRuntimeControl() {
  if (!existsSync(runtimeControlPath)) return null;
  try {
    return JSON.parse(readFileSync(runtimeControlPath, "utf8"));
  } catch {
    return null;
  }
}

export function buildRuntimeControlDocument({
  now = new Date(),
  revision,
  ttlMs = MAX_CONTROL_TTL_MS,
  killSwitch = { active: false, reasonCode: "none" },
} = {}) {
  const nextRevision = revision ?? (readCurrentRuntimeControl()?.revision ?? -1) + 1;
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    revision: nextRevision,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    killSwitch,
  };
}

/**
 * Validates and atomically publishes a runtime-control document to
 * .runtime/generated/runtime-control.json (nginx's alias target for
 * /observability/control.json — see infrastructure/docker/reverse-proxy).
 * Every publish — including the very first, at lab:init — goes through the
 * exact same schema/lifetime validation the browser package itself uses, so
 * a bug here can never publish a document the SDK would reject.
 */
export function generateRuntimeControl(options = {}) {
  const document = buildRuntimeControlDocument(options);
  const shape = validateControlDocumentShape(document);
  if (!shape.valid) {
    throw new Error(
      `generated runtime-control document failed schema validation: ${shape.reasonCode}`,
    );
  }
  const lifetime = validateControlLifetime(document, options.now ?? new Date());
  if (!lifetime.valid) {
    throw new Error(
      `generated runtime-control document failed lifetime validation: ${lifetime.reasonCode}`,
    );
  }
  atomicWriteFile(runtimeControlPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
  return document;
}

/**
 * Re-stamps the runtime-control document with a fresh issuedAt/expiresAt
 * window and bumped revision, preserving whatever killSwitch state is
 * already live. Unlike calling generateRuntimeControl() directly, this
 * never defaults killSwitch back to inactive — a periodic refresh must
 * never silently undo an operator's `pnpm lab:kill-switch:on`.
 */
export function refreshRuntimeControl() {
  const current = readCurrentRuntimeControl();
  const killSwitch = current?.killSwitch ?? { active: false, reasonCode: "none" };
  return generateRuntimeControl({ killSwitch });
}
