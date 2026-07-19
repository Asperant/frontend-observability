import { CONSENT } from "../internal/constants.js";
import { createCorrelationContext } from "../correlation/correlation-context.js";
import { createCounters } from "../diagnostics/counters.js";
import { ReasonCodes, isReasonCode } from "../diagnostics/reason-codes.js";
import { canTransition, LifecycleStates } from "./transitions.js";

export function createInitialRuntimeState() {
  const now = new Date().toISOString();
  return {
    state: LifecycleStates.IDLE,
    enabled: false,
    consent: CONSENT.NOT_GRANTED,
    service: null,
    environment: null,
    version: null,
    configVersion: null,
    adapter: null,
    adapterInstance: null,
    reasonCode: ReasonCodes.NONE,
    initializedAt: null,
    lastTransitionAt: now,
    counters: createCounters(),
    correlation: createCorrelationContext(),
    diagnostics: [],
    abortController: null,
    acceptingEvents: true,
  };
}

export function transition(runtime, nextState, reasonCode = ReasonCodes.NONE, now = new Date()) {
  if (runtime.state === nextState) {
    runtime.reasonCode = normalizeReasonCode(reasonCode);
    runtime.lastTransitionAt = now.toISOString();
    return { ok: true, state: runtime.state };
  }
  if (!canTransition(runtime.state, nextState)) {
    return { ok: false, state: runtime.state };
  }
  runtime.state = nextState;
  runtime.reasonCode = normalizeReasonCode(reasonCode);
  runtime.lastTransitionAt = now.toISOString();
  return { ok: true, state: runtime.state };
}

export function disableRuntime(runtime, reasonCode, now = new Date()) {
  runtime.enabled = false;
  runtime.adapter = null;
  runtime.adapterInstance = null;
  runtime.acceptingEvents = false;
  return transition(runtime, LifecycleStates.DISABLED, reasonCode, now);
}

export function activateRuntime(runtime, adapter, now = new Date()) {
  runtime.enabled = true;
  runtime.adapter = adapter.name;
  runtime.adapterInstance = adapter;
  runtime.acceptingEvents = true;
  runtime.initializedAt = runtime.initializedAt ?? now.toISOString();
  return transition(runtime, LifecycleStates.ACTIVE, ReasonCodes.NONE, now);
}

export function degradeRuntime(runtime, reasonCode = ReasonCodes.ADAPTER_ERROR, now = new Date()) {
  runtime.enabled = true;
  return transition(runtime, LifecycleStates.DEGRADED, reasonCode, now);
}

function normalizeReasonCode(reasonCode) {
  return isReasonCode(reasonCode) ? reasonCode : ReasonCodes.INTERNAL_ERROR;
}
