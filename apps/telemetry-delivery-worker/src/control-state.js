import { readFileSync } from "node:fs";

// Fail-closed: any missing/unreadable/malformed control state maps to
// { ready: false, held: true }. Only a structurally valid document with a
// boolean `hold` field is treated as ready, and its own `hold` value governs
// consumption. Never logs the raw document — only bounded reason codes.
export function readControlState(path) {
  if (!path) return { ready: false, held: true, reason: "control_env_missing" };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ready: false,
      held: true,
      reason: error?.code === "ENOENT" ? "control_file_missing" : "control_file_unreadable",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ready: false, held: true, reason: "control_file_malformed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ready: false, held: true, reason: "control_document_invalid" };
  }
  if (typeof parsed.hold !== "boolean") {
    return { ready: false, held: true, reason: "control_document_invalid" };
  }
  return {
    ready: true,
    held: parsed.hold,
    reason: parsed.hold ? "hold_requested" : "hold_clear",
  };
}

// A worker may only consume when the control state is a valid, explicit
// hold=false document — never on a missing/invalid/unevaluated default.
export function isConsumptionAllowed(controlState) {
  return controlState.ready === true && controlState.held === false;
}

// /readyz must report unready both when the control mechanism itself is
// invalid AND when it is validly holding — a held worker cannot do its job,
// so it must not be reported ready even though its control state is healthy.
export function isDeliveryReady(connectionReady, controlState) {
  return connectionReady && isConsumptionAllowed(controlState);
}

export function controlStateChanged(current, next) {
  return (
    current.ready !== next.ready || current.held !== next.held || current.reason !== next.reason
  );
}
