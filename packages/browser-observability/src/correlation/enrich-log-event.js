import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { recordSanitization } from "../diagnostics/counters.js";
import { recordCorrelation } from "./counters.js";
import { createMetadata } from "./enrich-rum-event.js";
import { extractNativeContext, extractNativeContextFromSdk } from "./extract-native-context.js";
import { stripReservedFields } from "./reserved-fields.js";

export function enrichLogEvent(
  event,
  domainContext,
  correlation,
  { counters, getInternalContext } = {},
) {
  try {
    if (!event || typeof event !== "object" || !correlation?.epochId) {
      recordCorrelation(counters, "unavailable");
      recordSanitization(counters, "redact", [ReasonCodes.CORRELATION_CONTEXT_UNAVAILABLE]);
      return false;
    }
    const stripped = stripReservedFields(event.context, { counters });
    if (stripped.removed) {
      recordSanitization(counters, "redact", [ReasonCodes.CORRELATION_RESERVED_FIELD_REMOVED]);
    }
    event.context = { ...(stripped.value ?? {}) };
    const nativeFromEvent = extractNativeContext(event, domainContext, { counters });
    const nativeFromSdk = extractNativeContextFromSdk(getInternalContext, event.date, { counters });
    const native = {
      sessionId: nativeFromEvent.sessionId ?? nativeFromSdk.sessionId,
      viewId: nativeFromEvent.viewId ?? nativeFromSdk.viewId,
      actionId: nativeFromEvent.actionId ?? nativeFromSdk.actionId,
    };
    const metadata = createMetadata(correlation.epochId, native);
    for (const [key, value] of Object.entries(metadata)) {
      event.context[key] = value;
    }
    recordCorrelation(counters, native.sessionId && native.viewId ? "enriched" : "partial");
    return undefined;
  } catch {
    recordCorrelation(counters, "unavailable");
    recordSanitization(counters, "drop", [ReasonCodes.CORRELATION_ENRICHMENT_FAILED]);
    return false;
  }
}
