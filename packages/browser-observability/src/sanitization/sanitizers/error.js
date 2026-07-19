import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { accept, drop, isDrop, redact, uniqueReasons } from "../diagnostics/results.js";
import { sanitizeAttributes } from "./attributes.js";
import { sanitizeString } from "./string.js";

export function sanitizeError(error, context) {
  try {
    const normalized = normalizeError(error);
    const message = sanitizeString(normalized.message, { maxLength: 512 });
    const stack = sanitizeStack(normalized.stack);
    const ctx = sanitizeAttributes(context, { maxBytes: 4 * 1024, maxItems: 12 });
    if (isDrop(message) || isDrop(stack) || isDrop(ctx)) {
      return drop(firstReason([message, stack, ctx]));
    }
    const safeError = Object.freeze({
      name: normalized.name,
      message: message.value,
      stack: stack.value,
    });
    const value = Object.freeze({ error: safeError, context: ctx.value });
    const reasons = uniqueReasons([message, stack, ctx]);
    return reasons.length > 0 ? redact(value, reasons) : accept(value);
  } catch {
    /* v8 ignore next -- defensive fail-closed guard for unexpected host runtime faults */
    return drop(ReasonCodes.SANITIZER_FAILURE);
  }
}

export function sanitizeStack(stack) {
  try {
    if (typeof stack !== "string" || stack.length === 0) return accept(undefined);
    const frames = stack
      .split("\n")
      .slice(0, 20)
      .join("\n")
      .slice(0, 8 * 1024);
    return sanitizeString(frames, { maxLength: 8 * 1024 });
  } catch {
    /* v8 ignore next -- defensive fail-closed guard for unexpected host runtime faults */
    return drop(ReasonCodes.SANITIZER_FAILURE);
  }
}

function normalizeError(error) {
  try {
    if (error instanceof Error) {
      return {
        name: sanitizeName(error.name),
        message: typeof error.message === "string" ? error.message : "",
        stack: typeof error.stack === "string" ? error.stack : undefined,
      };
    }
    if (typeof error === "string") {
      return { name: "Error", message: error, stack: undefined };
    }
  } catch {
    return { name: "UnknownError", message: "Unknown error", stack: undefined };
  }
  return { name: "UnknownError", message: "Unknown error", stack: undefined };
}

function sanitizeName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_. -]{1,128}$/.test(name)
    ? name.slice(0, 128)
    : "Error";
}

function firstReason(results) {
  /* v8 ignore next -- all internal drop results carry a reason */
  return results.find(isDrop)?.reasons?.[0] ?? ReasonCodes.SANITIZER_FAILURE;
}
