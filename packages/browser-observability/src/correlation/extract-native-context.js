import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { recordCorrelation } from "./counters.js";
import { validateCorrelationId } from "./validate-correlation-id.js";

export function extractNativeContext(event, domainContext, { counters } = {}) {
  const candidates = [
    {
      sessionId: event?.session?.id ?? event?.session_id,
      viewId: event?.view?.id ?? event?.view_id,
      actionId: event?.action?.id ?? event?.action_id ?? event?.user_action?.id,
    },
    {
      sessionId: domainContext?.session_id ?? domainContext?.session?.id,
      viewId: domainContext?.view?.id ?? domainContext?.view_id,
      actionId: domainContext?.user_action?.id ?? domainContext?.action?.id,
    },
  ];
  return firstValidContext(candidates, { counters });
}

export function extractNativeContextFromSdk(getInternalContext, startTime, { counters } = {}) {
  if (typeof getInternalContext !== "function") return {};
  try {
    return firstValidContext([getInternalContext(startTime)], { counters });
  } catch {
    recordCorrelation(counters, "unavailable");
    return {};
  }
}

function firstValidContext(candidates, { counters } = {}) {
  const output = {};
  let invalid = false;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const sessionId = readId(candidate.sessionId ?? candidate.session_id);
    const viewId = readId(candidate.viewId ?? candidate.view_id ?? candidate.view?.id);
    const actionId = readId(candidate.actionId ?? candidate.action_id ?? candidate.user_action?.id);
    if (sessionId && !output.sessionId) output.sessionId = sessionId;
    if (viewId && !output.viewId) output.viewId = viewId;
    if (actionId && !output.actionId) output.actionId = actionId;
    invalid ||= hasInvalidId(candidate);
  }
  if (invalid) {
    recordCorrelation(counters, "invalidNativeId");
    output.reasonCode = ReasonCodes.CORRELATION_NATIVE_ID_INVALID;
  }
  return output;
}

function readId(value) {
  return validateCorrelationId(value) ? value : null;
}

function hasInvalidId(candidate) {
  for (const value of [
    candidate.sessionId,
    candidate.session_id,
    candidate.viewId,
    candidate.view_id,
    candidate.view?.id,
    candidate.actionId,
    candidate.action_id,
    candidate.user_action?.id,
    candidate.action?.id,
  ]) {
    if (value !== undefined && value !== null && !validateCorrelationId(value)) return true;
  }
  return false;
}
