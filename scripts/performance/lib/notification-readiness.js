// Pure classification logic for the resilience end-to-end notification
// readiness probe. No network I/O here — scripts/performance/verify-resilience.mjs
// (and lab:alerts:test-notification-style helpers it reuses) fire the real
// probe against the lab and pass the observed timings/events through this
// module. 100%-coverage-gated (see vitest.config.js's "scripts/performance/lib/**" entry).

export const NOTIFICATION_READINESS_STATUS = Object.freeze({
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  FAILED: "FAILED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
});

/** Generates a probe id unique enough to unambiguously match its own events back out of alert-sink's event log. */
export function buildProbeId(randomUuid = crypto.randomUUID()) {
  return `resilience-notification-probe-${randomUuid}`;
}

/**
 * Finds this probe's firing/resolved events inside an alert-sink events
 * array (tests/fixtures/apps/http-test-service's `GET /alert-sink/events` shape: `{ receivedAt,
 * body: { dedupKey, status, ... } }`), matched by dedupKey === probeId.
 */
export function parseProbeEvents(events, probeId) {
  const matches = (Array.isArray(events) ? events : []).filter(
    (event) => event?.body?.dedupKey === probeId,
  );
  const firing = matches.find((event) => event.body.status === "firing") ?? null;
  const resolved = matches.find((event) => event.body.status === "resolved") ?? null;
  return {
    firingObserved: firing !== null,
    firingReceivedAt: firing?.receivedAt ?? null,
    resolvedObserved: resolved !== null,
    resolvedReceivedAt: resolved?.receivedAt ?? null,
  };
}

/**
 * Classifies overall notification readiness from a single probe result.
 * `input`:
 *   - destinationConfigured: boolean — the alert-sink webhook destination exists in OpenObserve.
 *   - firingObserved / resolvedObserved: boolean
 *   - firingLatencyMs / resolvedLatencyMs: number|null — probe-send to alert-sink-received.
 *   - targetLatencyMs: soft budget (DEGRADED above this, still HEALTHY-eligible below).
 *   - hardTimeoutMs: the probe's own wait bound; an event never observed is FAILED regardless of this value.
 *
 * A silent notification loss (destination configured, both events missing)
 * must classify as FAILED, never HEALTHY, however green the containers'
 * own healthchecks are — that is the entire point of this probe.
 */
export function classifyNotificationReadiness(input) {
  if (!input.destinationConfigured) {
    return {
      status: NOTIFICATION_READINESS_STATUS.NOT_CONFIGURED,
      reason: "no alert-sink destination is configured in OpenObserve",
    };
  }

  if (!input.firingObserved && !input.resolvedObserved) {
    return {
      status: NOTIFICATION_READINESS_STATUS.FAILED,
      reason: "neither the firing nor the resolved probe notification reached alert-sink",
    };
  }
  if (!input.firingObserved) {
    return {
      status: NOTIFICATION_READINESS_STATUS.FAILED,
      reason: "the firing probe notification never reached alert-sink",
    };
  }
  if (!input.resolvedObserved) {
    return {
      status: NOTIFICATION_READINESS_STATUS.FAILED,
      reason: "the resolved probe notification never reached alert-sink",
    };
  }

  const latencies = [input.firingLatencyMs, input.resolvedLatencyMs].filter(
    (value) => value !== null && value !== undefined,
  );
  const exceedsHardTimeout = latencies.some((value) => value > input.hardTimeoutMs);
  if (exceedsHardTimeout) {
    return {
      status: NOTIFICATION_READINESS_STATUS.FAILED,
      reason: `a probe notification exceeded the hard timeout of ${input.hardTimeoutMs}ms`,
    };
  }

  const exceedsTargetLatency = latencies.some((value) => value > input.targetLatencyMs);
  if (exceedsTargetLatency) {
    return {
      status: NOTIFICATION_READINESS_STATUS.DEGRADED,
      reason: `a probe notification exceeded the target latency of ${input.targetLatencyMs}ms but arrived within the hard timeout`,
    };
  }

  return {
    status: NOTIFICATION_READINESS_STATUS.HEALTHY,
    reason: "firing and resolved probe notifications both arrived within target latency",
  };
}
