// I/O wrapper that fires a real Stage 19 notification-readiness probe
// against the lab and classifies the result through
// scripts/performance/lib/notification-readiness.js's pure logic. Not
// coverage-gated (pure I/O), mirrors scripts/lab/alerts-test-notification.mjs,
// whose exact "test destination" primitive this reuses — that is the same
// real HTTP path (OpenObserve admin API -> real webhook destination call ->
// real alert-sink container) Stage 17 already validated, just wrapped with a
// unique dedupKey per call, bounded polling, and HEALTHY/DEGRADED/FAILED/
// NOT_CONFIGURED classification instead of a boolean pass/fail.
//
// Leaves no persistent OpenObserve-side artifact: "test destination" posts
// directly to the destination URL without creating an alert/rule object.
// The only trace is one entry in alert-sink's own bounded in-memory event
// ring buffer (apps/mock-api's MAX_ALERT_SINK_EVENTS=100), which rolls off
// on its own — there is nothing to explicitly delete.

import { LOCAL_DESTINATION_NAME } from "../../lab/alerts-install-starters.mjs";
import {
  alertSinkControl,
  listDestinations,
  readAdminAuthHeader,
  testLocalDestination,
} from "../../lab/alerts/admin-client.mjs";
import {
  buildProbeId,
  classifyNotificationReadiness,
  parseProbeEvents,
} from "./notification-readiness.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fires one unique probe alert through the real local alert-sink
 * destination, polls (bounded) for its firing + resolved notifications, and
 * classifies overall readiness. Never throws on a degraded/failed lab —
 * a FAILED classification IS the expected way to report a broken pipeline.
 */
export async function runNotificationReadinessProbe({
  targetLatencyMs = 5000,
  hardTimeoutMs = 15000,
  pollIntervalMs = 500,
} = {}) {
  const auth = readAdminAuthHeader();
  const destinations = await listDestinations(auth);
  const destinationConfigured = destinations.some((dest) => dest.name === LOCAL_DESTINATION_NAME);
  if (!destinationConfigured) {
    return {
      ...classifyNotificationReadiness({
        destinationConfigured: false,
        firingObserved: false,
        resolvedObserved: false,
        firingLatencyMs: null,
        resolvedLatencyMs: null,
        targetLatencyMs,
        hardTimeoutMs,
      }),
      probeId: null,
      firingLatencyMs: null,
      resolvedLatencyMs: null,
    };
  }

  const probeId = buildProbeId();
  const sentAtMs = Date.now();
  await testLocalDestination(auth, {
    alert: probeId,
    severity: "low",
    status: "firing",
    service: "probe",
    environment: "lab",
    version: "probe",
    measuredValue: "1",
    threshold: "1",
    sampleSize: "1",
    evaluationWindow: "1m",
    firingTime: new Date(sentAtMs).toISOString(),
    dashboardRef: "probe",
    runbookRef: "probe",
    dedupKey: probeId,
  });
  await testLocalDestination(auth, {
    alert: probeId,
    severity: "low",
    status: "resolved",
    service: "probe",
    environment: "lab",
    dedupKey: probeId,
  });

  const deadlineMs = sentAtMs + hardTimeoutMs;
  let parsed = {
    firingObserved: false,
    resolvedObserved: false,
    firingReceivedAt: null,
    resolvedReceivedAt: null,
  };
  while (Date.now() < deadlineMs && !(parsed.firingObserved && parsed.resolvedObserved)) {
    const { events } = alertSinkControl("events");
    parsed = parseProbeEvents(events, probeId);
    if (!(parsed.firingObserved && parsed.resolvedObserved)) {
      await sleep(pollIntervalMs);
    }
  }

  const firingLatencyMs = parsed.firingReceivedAt
    ? new Date(parsed.firingReceivedAt).getTime() - sentAtMs
    : null;
  const resolvedLatencyMs = parsed.resolvedReceivedAt
    ? new Date(parsed.resolvedReceivedAt).getTime() - sentAtMs
    : null;

  const classification = classifyNotificationReadiness({
    destinationConfigured: true,
    firingObserved: parsed.firingObserved,
    resolvedObserved: parsed.resolvedObserved,
    firingLatencyMs,
    resolvedLatencyMs,
    targetLatencyMs,
    hardTimeoutMs,
  });

  return { ...classification, probeId, firingLatencyMs, resolvedLatencyMs };
}
