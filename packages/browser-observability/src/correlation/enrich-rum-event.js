import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { recordSanitization } from "../diagnostics/counters.js";
import { recordCorrelation } from "./counters.js";
import { CORRELATION_SCHEMA_VERSION } from "./correlation-context.js";
import { extractNativeContext } from "./extract-native-context.js";
import { stripReservedFields } from "./reserved-fields.js";
import { validateCorrelationId } from "./validate-correlation-id.js";

export function enrichRumEvent(event, domainContext, correlation, { counters } = {}) {
  try {
    if (!event || typeof event !== "object" || !correlation?.epochId) {
      recordCorrelation(counters, "unavailable");
      recordSanitization(counters, "redact", [ReasonCodes.CORRELATION_CONTEXT_UNAVAILABLE]);
      return false;
    }
    const stripped = stripReservedFields(event.context, { counters });
    event.context = { ...(stripped.value ?? {}) };
    if (stripped.removed) {
      recordSanitization(counters, "redact", [ReasonCodes.CORRELATION_RESERVED_FIELD_REMOVED]);
    }

    const native = extractNativeContext(event, domainContext, { counters });
    const metadata = createMetadata(correlation.epochId, native);
    for (const [key, value] of Object.entries(metadata)) {
      event.context[key] = value;
    }
    if (native.sessionId) correlation.nativeSessionId = native.sessionId;
    if (native.viewId) correlation.nativeViewId = native.viewId;
    const complete =
      native.sessionId && native.viewId && (event.type !== "action" || native.actionId);
    recordCorrelation(counters, complete ? "enriched" : "partial");
    if (!complete && event.type === "action") {
      recordSanitization(counters, "redact", [ReasonCodes.CORRELATION_ACTION_UNAVAILABLE]);
    }
    return undefined;
  } catch {
    recordCorrelation(counters, "unavailable");
    recordSanitization(counters, "drop", [ReasonCodes.CORRELATION_ENRICHMENT_FAILED]);
    return false;
  }
}

export function createMetadata(epochId, native = {}) {
  const metadata = {
    "frontend-observability.correlation.schema_version": CORRELATION_SCHEMA_VERSION,
  };
  if (validateCorrelationId(epochId))
    metadata["frontend-observability.correlation.epoch_id"] = epochId;
  if (validateCorrelationId(native.sessionId)) {
    metadata["frontend-observability.correlation.session_id"] = native.sessionId;
  }
  if (validateCorrelationId(native.viewId))
    metadata["frontend-observability.correlation.view_id"] = native.viewId;
  if (validateCorrelationId(native.actionId)) {
    metadata["frontend-observability.correlation.action_id"] = native.actionId;
  }
  return Object.freeze(metadata);
}
