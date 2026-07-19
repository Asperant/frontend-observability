import { isReasonCode } from "../diagnostics/reason-codes.js";

const REQUIRED_METHODS = Object.freeze([
  "initialize",
  "setTrackingConsent",
  "recordAction",
  "recordError",
  "startSessionReplay",
  "stopSessionReplay",
  "shutdown",
  "getCapabilities",
]);

export function isValidAdapter(adapter) {
  return (
    adapter !== null &&
    typeof adapter === "object" &&
    typeof adapter.name === "string" &&
    adapter.name.length > 0 &&
    REQUIRED_METHODS.every((method) => typeof adapter[method] === "function")
  );
}

/**
 * An adapter's initialize() may throw a controlled error carrying a
 * `reasonCode` (one of diagnostics/reason-codes.js) to report a specific,
 * recognized failure (e.g. the underlying SDK failing to initialize)
 * instead of the generic ADAPTER_ERROR/ADAPTER_UNAVAILABLE fallback. The
 * thrown error itself — and any vendor SDK exception it wraps — never
 * reaches the caller; only the recognized reasonCode does.
 */
export async function initializeAdapter(adapterFactory, context) {
  if (typeof adapterFactory !== "function") {
    return { ok: false, adapter: null };
  }
  const adapter = await adapterFactory(context);
  if (!isValidAdapter(adapter)) {
    return { ok: false, adapter: null };
  }
  try {
    await adapter.initialize(context);
  } catch (error) {
    return {
      ok: false,
      adapter: null,
      thrown: true,
      reasonCode: isReasonCode(error?.reasonCode) ? error.reasonCode : undefined,
    };
  }
  return { ok: true, adapter };
}
