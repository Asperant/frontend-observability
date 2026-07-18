import { MAX_DIAGNOSTICS } from "../internal/constants.js";
import { getState } from "../internal/state.js";

const VALID_LEVELS = new Set(["debug", "info", "warn", "error"]);

export function recordDiagnostic(level, code, message, context) {
  const state = getState();
  const entry = Object.freeze({
    schemaVersion: "1.0.0",
    level: VALID_LEVELS.has(level) ? level : "info",
    code: typeof code === "string" && code.length > 0 ? code : "diagnostic.unknown",
    message: typeof message === "string" ? message.slice(0, 512) : "",
    timestamp: new Date().toISOString(),
    context: context && typeof context === "object" ? Object.freeze({ ...context }) : undefined,
  });

  state.diagnostics.push(entry);
  if (state.diagnostics.length > MAX_DIAGNOSTICS) {
    state.diagnostics.shift();
  }

  return entry;
}

export function getDiagnostics() {
  return [...getState().diagnostics];
}
