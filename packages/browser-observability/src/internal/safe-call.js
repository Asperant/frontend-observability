import { ReasonCodes } from "../diagnostics/reason-codes.js";

export function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export async function safeCallAsync(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function publicFallback() {
  return { ok: false, reasonCode: ReasonCodes.INTERNAL_ERROR };
}
