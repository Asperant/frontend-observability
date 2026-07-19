import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { hasHighRiskIdentifier } from "../detectors/sensitive-values.js";
import { accept, drop, isDrop, redact, uniqueReasons } from "../diagnostics/results.js";
import { sanitizeAttributes } from "./attributes.js";

const ACTION_NAME_PATTERN = /^[a-z0-9.-]+$/;

export function sanitizeAction(name, attributes) {
  try {
    const nameResult = sanitizeActionName(name);
    if (isDrop(nameResult)) return nameResult;
    const attributesResult = sanitizeAttributes(attributes);
    if (isDrop(attributesResult)) return attributesResult;
    const value = Object.freeze({ name: nameResult.value, attributes: attributesResult.value });
    const reasons = uniqueReasons([nameResult, attributesResult]);
    return reasons.length > 0 ? redact(value, reasons) : accept(value);
  } catch {
    /* v8 ignore next -- defensive fail-closed guard for unexpected host runtime faults */
    return drop(ReasonCodes.SANITIZER_FAILURE);
  }
}

export function sanitizeActionName(name) {
  try {
    if (typeof name !== "string") return drop(ReasonCodes.ACTION_NAME_INVALID);
    const trimmed = name.trim();
    const segments = trimmed.split(".");
    if (
      trimmed.length < 3 ||
      trimmed.length > 80 ||
      !ACTION_NAME_PATTERN.test(trimmed) ||
      segments.length > 6 ||
      segments.some((segment) => segment.length === 0)
    ) {
      return drop(ReasonCodes.ACTION_NAME_INVALID);
    }
    if (hasHighRiskIdentifier(trimmed)) return drop(ReasonCodes.ACTION_NAME_INVALID);
    return accept(trimmed);
  } catch {
    /* v8 ignore next -- defensive fail-closed guard for unexpected host runtime faults */
    return drop(ReasonCodes.SANITIZER_FAILURE);
  }
}
