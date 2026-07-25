// Pure timing/classification/drift logic for restart-recovery scenarios
// (infrastructure/performance/resilience-recovery-matrix.json). No process
// spawning here — scripts/performance/verify-resilience.mjs records
// raw timestamps/state snapshots and passes them through this module.
// 100%-coverage-gated (see vitest.config.js's "scripts/performance/lib/**" entry).

/**
 * `events` is `{ restartIssuedAtMs, becameUnhealthyAtMs, becameHealthyAtMs,
 * firstSuccessfulIngestAtMs, firstSuccessfulQueryAtMs, firstSuccessfulNotificationAtMs }`.
 * Any of the `firstSuccessful*` fields may be `null` when that dimension does
 * not apply to a given scenario (see the recovery-matrix.json `measure` list).
 */
export function computeRecoveryTimings(events) {
  if (!Number.isFinite(events.restartIssuedAtMs) || !Number.isFinite(events.becameHealthyAtMs)) {
    throw new Error("computeRecoveryTimings requires restartIssuedAtMs and becameHealthyAtMs");
  }
  const detectionTimeMs =
    events.becameUnhealthyAtMs !== null && events.becameUnhealthyAtMs !== undefined
      ? events.becameUnhealthyAtMs - events.restartIssuedAtMs
      : null;
  const unreadyDurationMs =
    detectionTimeMs !== null ? events.becameHealthyAtMs - events.becameUnhealthyAtMs : null;
  const recoveryTimeMs = events.becameHealthyAtMs - events.restartIssuedAtMs;

  const relativeToHealthy = (fieldMs) =>
    fieldMs === null || fieldMs === undefined ? null : fieldMs - events.becameHealthyAtMs;

  return {
    detectionTimeMs,
    unreadyDurationMs,
    recoveryTimeMs,
    ingestRecoveryMs: relativeToHealthy(events.firstSuccessfulIngestAtMs),
    queryRecoveryMs: relativeToHealthy(events.firstSuccessfulQueryAtMs),
    notificationRecoveryMs: relativeToHealthy(events.firstSuccessfulNotificationAtMs),
  };
}

/**
 * `thresholds` is a `{ [timingKey]: maxMs }` map (a subset of the keys
 * computeRecoveryTimings returns). A timing present in `thresholds` but
 * `null` in `timings` (the scenario didn't measure that dimension) is
 * skipped, not failed.
 */
export function classifyRecovery(timings, thresholds) {
  const results = Object.entries(thresholds).map(([key, maxMs]) => {
    const value = timings[key];
    if (value === null || value === undefined) {
      return { key, skipped: true, pass: true, value: null, maxMs };
    }
    return { key, skipped: false, pass: value <= maxMs, value, maxMs };
  });
  return { overallPass: results.every((result) => result.pass), results };
}

/**
 * Shallow-compares two `{ [key]: value }` state snapshots (read-back counts,
 * e.g. `{ streamRumdata: true, starterAlerts6: 6, ... }`) and reports any
 * key whose value changed. Drift is always reported flat — no severity
 * weighting — per the recovery-matrix.json driftPolicy: any drift is a
 * finding, not a soft warning.
 */
export function detectStateDrift(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const drifted = [];
  for (const key of keys) {
    const beforeValue = before[key];
    const afterValue = after[key];
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      drifted.push({ key, before: beforeValue, after: afterValue });
    }
  }
  return { hasDrift: drifted.length > 0, drifted };
}

/**
 * A scenario's restart-count expectation check: the target service's own
 * compose restart count must have increased by exactly 1, and — unless
 * `allowedSideEffects` names it — no other service's restart count may have
 * changed. Matches recovery-matrix.json's restartCountExpectation.
 */
export function verifyRestartCountExpectation(
  target,
  restartCountsBefore,
  restartCountsAfter,
  allowedSideEffects = [],
) {
  const violations = [];
  for (const service of Object.keys(restartCountsAfter)) {
    const delta = restartCountsAfter[service] - (restartCountsBefore[service] ?? 0);
    if (service === target) {
      if (delta !== 1) {
        violations.push({ service, expectedDelta: 1, actualDelta: delta });
      }
    } else if (allowedSideEffects.includes(service)) {
      if (delta !== 0 && delta !== 1) {
        violations.push({
          service,
          expectedDelta: "0 or 1 (allowed side effect)",
          actualDelta: delta,
        });
      }
    } else if (delta !== 0) {
      violations.push({ service, expectedDelta: 0, actualDelta: delta });
    }
  }
  return { pass: violations.length === 0, violations };
}
