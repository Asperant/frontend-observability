const CORRELATION_COUNTER_KEYS = Object.freeze([
  "enriched",
  "partial",
  "unavailable",
  "invalidNativeId",
  "reservedFieldRemoved",
]);

export function createCorrelationCounters() {
  return Object.fromEntries(CORRELATION_COUNTER_KEYS.map((key) => [key, 0]));
}

export function recordCorrelation(counters, key) {
  if (!counters?.correlation || !CORRELATION_COUNTER_KEYS.includes(key)) return false;
  counters.correlation[key] = Math.max(0, counters.correlation[key] || 0) + 1;
  return true;
}

export function snapshotCorrelationCounters(counters) {
  const correlation = counters?.correlation ?? {};
  return Object.freeze(
    Object.fromEntries(
      CORRELATION_COUNTER_KEYS.map((key) => [key, Math.max(0, correlation[key] || 0)]),
    ),
  );
}
