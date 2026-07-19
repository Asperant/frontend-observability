import { sanitizeActionName } from "../sanitization/sanitizers/action.js";

export function isValidActionName(name) {
  return sanitizeActionName(name).decision !== "drop";
}
