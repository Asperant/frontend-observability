const COUNTER_KEYS = Object.freeze([
  "acceptedActions",
  "droppedActions",
  "acceptedErrors",
  "droppedErrors",
]);

const SANITIZATION_KEYS = Object.freeze(["accepted", "redacted", "dropped"]);

export function createCounters() {
  return {
    acceptedActions: 0,
    droppedActions: 0,
    acceptedErrors: 0,
    droppedErrors: 0,
    sanitization: {
      accepted: 0,
      redacted: 0,
      dropped: 0,
      reasons: {},
    },
  };
}

export function incrementCounter(counters, key) {
  if (!COUNTER_KEYS.includes(key)) return false;
  counters[key] = Math.max(0, counters[key]) + 1;
  return true;
}

export function snapshotCounters(counters) {
  return Object.freeze(
    Object.fromEntries(COUNTER_KEYS.map((key) => [key, Math.max(0, counters[key] || 0)])),
  );
}

export function recordSanitization(counters, decision, reasons = []) {
  const key = normalizeSanitizationDecision(decision);
  if (!counters?.sanitization || !SANITIZATION_KEYS.includes(key)) return false;
  counters.sanitization[key] = Math.max(0, counters.sanitization[key] || 0) + 1;
  for (const reason of reasons) {
    if (typeof reason !== "string" || reason.length === 0) continue;
    counters.sanitization.reasons[reason] =
      Math.max(0, counters.sanitization.reasons[reason] || 0) + 1;
  }
  return true;
}

function normalizeSanitizationDecision(decision) {
  if (decision === "accept") return "accepted";
  if (decision === "redact") return "redacted";
  if (decision === "drop") return "dropped";
  return decision;
}

export function snapshotSanitization(counters) {
  const sanitization = counters?.sanitization ?? {};
  const reasons = sanitization.reasons ?? {};
  return Object.freeze({
    accepted: Math.max(0, sanitization.accepted || 0),
    redacted: Math.max(0, sanitization.redacted || 0),
    dropped: Math.max(0, sanitization.dropped || 0),
    reasons: Object.freeze(
      Object.fromEntries(
        Object.entries(reasons)
          .filter(([key, value]) => typeof key === "string" && Number.isFinite(value))
          .map(([key, value]) => [key, Math.max(0, value)]),
      ),
    ),
  });
}
