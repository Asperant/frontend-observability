const COUNTER_KEYS = Object.freeze([
  "acceptedActions",
  "droppedActions",
  "acceptedErrors",
  "droppedErrors",
]);

export function createCounters() {
  return {
    acceptedActions: 0,
    droppedActions: 0,
    acceptedErrors: 0,
    droppedErrors: 0,
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
