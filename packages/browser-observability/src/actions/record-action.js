import { getRuntimeState } from "../bootstrap/runtime-registry.js";
import { CONSENT } from "../internal/constants.js";
import { incrementCounter } from "../diagnostics/counters.js";
import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { degradeRuntime } from "../lifecycle/state-machine.js";
import { LifecycleStates } from "../lifecycle/transitions.js";
import { createStatusSnapshot } from "../status/snapshot.js";
import { recordSanitization } from "../diagnostics/counters.js";
import { sanitizeAction } from "../sanitization/sanitizers/action.js";

export function recordAction(name, attributes) {
  const runtime = getRuntimeState();

  if (runtime.state !== LifecycleStates.ACTIVE || !runtime.acceptingEvents) {
    incrementCounter(runtime.counters, "droppedActions");
    return result(false, runtime, ReasonCodes.NOT_ACTIVE);
  }
  if (runtime.consent !== CONSENT.GRANTED) {
    incrementCounter(runtime.counters, "droppedActions");
    return result(false, runtime, ReasonCodes.CONSENT_NOT_GRANTED);
  }
  if (!isPlainAttributes(attributes)) {
    incrementCounter(runtime.counters, "droppedActions");
    return result(false, runtime, ReasonCodes.INVALID_ACTION);
  }

  const sanitized = sanitizeAction(name, attributes);
  recordSanitization(runtime.counters, sanitized.decision, sanitized.reasons);
  if (sanitized.decision === "drop") {
    incrementCounter(runtime.counters, "droppedActions");
    return result(false, runtime, sanitized.reasons[0] ?? ReasonCodes.INVALID_ACTION);
  }

  try {
    runtime.adapterInstance.recordAction(sanitized.value.name, sanitized.value.attributes);
    incrementCounter(runtime.counters, "acceptedActions");
    return result(true, runtime, ReasonCodes.NONE);
  } catch {
    incrementCounter(runtime.counters, "droppedActions");
    degradeRuntime(runtime, ReasonCodes.ADAPTER_ERROR);
    return result(false, runtime, ReasonCodes.ADAPTER_ERROR);
  }
}

function isPlainAttributes(attributes) {
  return (
    attributes === undefined ||
    attributes === null ||
    (typeof attributes === "object" && !Array.isArray(attributes))
  );
}

function result(ok, runtime, reasonCode) {
  return { ok, state: runtime.state, reasonCode, status: createStatusSnapshot(runtime) };
}
