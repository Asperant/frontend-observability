import { getRuntimeState, replaceRuntimeState } from "../bootstrap/runtime-registry.js";
import { clearCorrelationContext } from "../correlation/correlation-context.js";
import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { stopRuntimeControlLoop } from "../runtime-control/refresh-engine.js";
import { createInitialRuntimeState, transition } from "./state-machine.js";
import { LifecycleStates } from "./transitions.js";
import { createStatusSnapshot } from "../status/snapshot.js";

export async function shutdownObservability() {
  const runtime = getRuntimeState();

  if (runtime.state === LifecycleStates.IDLE || runtime.state === LifecycleStates.SHUTDOWN) {
    return {
      ok: true,
      state: runtime.state,
      reasonCode: ReasonCodes.NONE,
      status: createStatusSnapshot(runtime),
    };
  }

  runtime.acceptingEvents = false;
  clearCorrelationContext(runtime.correlation);
  runtime.abortController?.abort();
  // Stops the runtime-control timer/listeners only — the page-lifetime
  // control registry itself (last-known-good document, revision, and most
  // importantly the kill-switch latch) is deliberately left intact so a
  // later reinitialize() on this same page resumes it rather than starting
  // over. See runtime-control/registry.js.
  stopRuntimeControlLoop();
  transition(runtime, LifecycleStates.SHUTTING_DOWN, ReasonCodes.SHUTDOWN);

  try {
    await runtime.adapterInstance?.stopSessionReplay?.();
  } catch {
    // Adapter shutdown path is isolated from the host application.
  }
  try {
    await runtime.adapterInstance?.shutdown?.();
  } catch {
    // Adapter shutdown path is isolated from the host application.
  }

  const nextRuntime = createInitialRuntimeState();
  nextRuntime.state = LifecycleStates.SHUTDOWN;
  nextRuntime.consent = runtime.consent;
  nextRuntime.service = runtime.service;
  nextRuntime.environment = runtime.environment;
  nextRuntime.version = runtime.version;
  nextRuntime.configVersion = null;
  nextRuntime.adapter = null;
  nextRuntime.reasonCode = ReasonCodes.NONE;
  nextRuntime.initializedAt = runtime.initializedAt;
  nextRuntime.lastTransitionAt = new Date().toISOString();
  nextRuntime.counters = runtime.counters;
  replaceRuntimeState(nextRuntime);

  return {
    ok: true,
    state: nextRuntime.state,
    reasonCode: ReasonCodes.NONE,
    status: createStatusSnapshot(nextRuntime),
  };
}
