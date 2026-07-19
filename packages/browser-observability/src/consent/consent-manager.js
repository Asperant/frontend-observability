import { CONSENT } from "../internal/constants.js";
import {
  clearCorrelationContext,
  grantCorrelationEpoch,
} from "../correlation/correlation-context.js";
import { getRuntimeState } from "../bootstrap/runtime-registry.js";
import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { LifecycleStates } from "../lifecycle/transitions.js";
import { degradeRuntime } from "../lifecycle/state-machine.js";
import { createStatusSnapshot } from "../status/snapshot.js";

const VALID_CONSENT = Object.freeze([CONSENT.GRANTED, CONSENT.NOT_GRANTED]);

export function setConsent(consent) {
  const runtime = getRuntimeState();
  if (!VALID_CONSENT.includes(consent)) {
    return result(false, runtime, ReasonCodes.INVALID_CONSENT);
  }

  const previous = runtime.consent;
  runtime.consent = consent;

  if (previous !== CONSENT.GRANTED && consent === CONSENT.GRANTED) {
    if (!grantCorrelationEpoch(runtime.correlation)) {
      runtime.consent = previous;
      clearCorrelationContext(runtime.correlation);
      return result(false, runtime, ReasonCodes.CORRELATION_CONTEXT_UNAVAILABLE);
    }
  }
  if (previous === CONSENT.GRANTED && consent === CONSENT.NOT_GRANTED) {
    clearCorrelationContext(runtime.correlation);
  }

  if (previous === CONSENT.GRANTED && consent === CONSENT.NOT_GRANTED && hasAdapter(runtime)) {
    safeAdapterCall(runtime, () => runtime.adapterInstance.stopSessionReplay());
  }
  if (hasAdapter(runtime)) {
    safeAdapterCall(runtime, () => runtime.adapterInstance.setTrackingConsent(consent));
  }

  return result(true, runtime, ReasonCodes.NONE);
}

function hasAdapter(runtime) {
  return (
    (runtime.state === LifecycleStates.ACTIVE || runtime.state === LifecycleStates.DEGRADED) &&
    runtime.adapterInstance
  );
}

function safeAdapterCall(runtime, fn) {
  try {
    fn();
  } catch {
    if (runtime.state === LifecycleStates.ACTIVE) {
      degradeRuntime(runtime, ReasonCodes.ADAPTER_ERROR);
    }
  }
}

function result(ok, runtime, reasonCode) {
  return { ok, state: runtime.state, reasonCode, status: createStatusSnapshot(runtime) };
}
