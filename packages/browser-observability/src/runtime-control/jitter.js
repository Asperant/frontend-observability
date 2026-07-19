/**
 * Deterministic, bounded jitter: derived from the monotonic refresh-attempt
 * counter (not Math.random()), so the same sequence of attempts always
 * produces the same sequence of delays — reproducible in tests, and
 * sufficient to avoid every tab reconverging on the exact same wall-clock
 * tick. Bounded to +/-10% of the base interval.
 */
export function applyJitter(baseIntervalMs, attemptCount) {
  const bound = Math.floor(baseIntervalMs * 0.1);
  if (bound <= 0) return baseIntervalMs;
  // A tiny linear-congruential step keyed by the attempt count — deterministic,
  // cheap, and spreads consecutive attempts across the jitter range.
  const pseudoRandom = ((attemptCount * 48271) % 2147483647) / 2147483647;
  const offset = Math.round(pseudoRandom * bound * 2) - bound;
  return baseIntervalMs + offset;
}
