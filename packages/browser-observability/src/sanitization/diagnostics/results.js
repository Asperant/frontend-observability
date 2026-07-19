export const SanitizationDecision = Object.freeze({
  ACCEPT: "accept",
  REDACT: "redact",
  DROP: "drop",
});

export function accept(value, reasons = []) {
  return Object.freeze({ decision: SanitizationDecision.ACCEPT, value, reasons });
}

export function redact(value, reasons = []) {
  return Object.freeze({ decision: SanitizationDecision.REDACT, value, reasons });
}

export function drop(reason) {
  return Object.freeze({
    decision: SanitizationDecision.DROP,
    value: undefined,
    reasons: [reason],
  });
}

export function isDrop(result) {
  return result?.decision === SanitizationDecision.DROP;
}

export function mergeDecision(results) {
  if (results.some(isDrop)) return SanitizationDecision.DROP;
  if (results.some((result) => result?.decision === SanitizationDecision.REDACT)) {
    return SanitizationDecision.REDACT;
  }
  return SanitizationDecision.ACCEPT;
}

export function uniqueReasons(results) {
  return [...new Set(results.flatMap((result) => result?.reasons ?? []))];
}
