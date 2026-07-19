import { getRuntimeState } from "../bootstrap/runtime-registry.js";
import { CONSENT } from "../internal/constants.js";
import { incrementCounter } from "../diagnostics/counters.js";
import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { degradeRuntime } from "../lifecycle/state-machine.js";
import { LifecycleStates } from "../lifecycle/transitions.js";
import { createStatusSnapshot } from "../status/snapshot.js";

export function recordError(error, context) {
  const runtime = getRuntimeState();

  if (runtime.state !== LifecycleStates.ACTIVE || !runtime.acceptingEvents) {
    incrementCounter(runtime.counters, "droppedErrors");
    return result(false, runtime, ReasonCodes.NOT_ACTIVE);
  }
  if (runtime.consent !== CONSENT.GRANTED) {
    incrementCounter(runtime.counters, "droppedErrors");
    return result(false, runtime, ReasonCodes.CONSENT_NOT_GRANTED);
  }
  if (!isPlainContext(context)) {
    incrementCounter(runtime.counters, "droppedErrors");
    return result(false, runtime, ReasonCodes.INVALID_ERROR);
  }
  try {
    runtime.adapterInstance.recordError(error, context ?? {});
    incrementCounter(runtime.counters, "acceptedErrors");
    return result(true, runtime, ReasonCodes.NONE);
  } catch {
    incrementCounter(runtime.counters, "droppedErrors");
    degradeRuntime(runtime, ReasonCodes.ADAPTER_ERROR);
    return result(false, runtime, ReasonCodes.ADAPTER_ERROR);
  }
}

function isPlainContext(context) {
  return (
    context === undefined ||
    context === null ||
    (typeof context === "object" && !Array.isArray(context))
  );
}

function result(ok, runtime, reasonCode) {
  return { ok, state: runtime.state, reasonCode, status: createStatusSnapshot(runtime) };
}
