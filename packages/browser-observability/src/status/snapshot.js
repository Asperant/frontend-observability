import { snapshotCorrelation } from "../correlation/correlation-context.js";
import {
  snapshotCorrelationCounters,
  snapshotCounters,
  snapshotSanitization,
} from "../diagnostics/counters.js";
import { snapshotRuntimeControl } from "../runtime-control/status.js";

export function createStatusSnapshot(runtime) {
  return deepFreeze({
    state: runtime.state,
    enabled: Boolean(runtime.enabled),
    consent: runtime.consent,
    service: runtime.service,
    environment: runtime.environment,
    version: runtime.version,
    configVersion: runtime.configVersion,
    adapter: runtime.adapter,
    reasonCode: runtime.reasonCode,
    initializedAt: runtime.initializedAt,
    lastTransitionAt: runtime.lastTransitionAt,
    counters: snapshotCounters(runtime.counters),
    sanitization: snapshotSanitization(runtime.counters),
    correlation: snapshotCorrelation(
      runtime.correlation,
      snapshotCorrelationCounters(runtime.counters),
      runtime,
    ),
    runtimeControl: snapshotRuntimeControl(),
  });
}

export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
