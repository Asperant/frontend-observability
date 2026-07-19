import { createConsentEpoch } from "./create-epoch.js";
import { createCorrelationCapabilities } from "./capabilities.js";

export const CORRELATION_SCHEMA_VERSION = "1";

export function createCorrelationContext() {
  return {
    epochId: null,
    nativeSessionId: null,
    nativeViewId: null,
    capabilities: createCorrelationCapabilities(),
  };
}

export function grantCorrelationEpoch(context) {
  if (!context) return false;
  context.epochId = createConsentEpoch();
  return Boolean(context.epochId);
}

export function clearCorrelationContext(context) {
  if (!context) return;
  context.epochId = null;
  context.nativeSessionId = null;
  context.nativeViewId = null;
}

export function updateCorrelationCapabilities(context, capabilities) {
  if (!context) return;
  context.capabilities = createCorrelationCapabilities(capabilities);
}

export function snapshotCorrelation(context, counters, state) {
  return Object.freeze({
    state: context?.epochId ? "active" : "unavailable",
    schemaVersion: Number(CORRELATION_SCHEMA_VERSION),
    capabilities: context?.capabilities ?? createCorrelationCapabilities(),
    counters,
    // No ID values are exposed here by design.
    lastReasonCode: state?.reasonCode ?? "NONE",
  });
}
