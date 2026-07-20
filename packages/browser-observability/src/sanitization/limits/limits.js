export const LIMITS = Object.freeze({
  // Upper bound on how much of a string value the regex-based PII/secret
  // detectors (detectors/patterns.js) are ever run against. Measured
  // empirically: redaction time grows super-linearly with input length
  // (~1.3s at 50,000 chars, ~5.2s at 100,000 chars on the reference
  // hardware used for Stage 18), so an unbounded attacker- or
  // user-supplied string passed into recordAction()/recordError() could
  // otherwise freeze the host page's JS thread for seconds to hours with a
  // single call. No realistic email/JWT/IBAN/card/phone/base64 token or
  // private-key header is anywhere near this long, so clamping the
  // *scanned* prefix here is safe and does not weaken detection for any
  // plausible real input; the sanitized output is truncated to the
  // caller's own (much smaller) maxLength regardless.
  maxSanitizerScanLength: 4096,
  maxUrlBytes: 1024,
  maxStringLength: 128,
  maxActionNameLength: 80,
  minActionNameLength: 3,
  maxActionNameSegments: 6,
  maxAttributeCount: 12,
  maxAttributeKeyLength: 48,
  maxAttributeBytes: 2 * 1024,
  maxErrorMessageLength: 512,
  maxStackBytes: 8 * 1024,
  maxStackFrames: 20,
  maxErrorCauseDepth: 3,
  maxErrorContextBytes: 4 * 1024,
});

export function byteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

export function truncateByChars(value, maxLength) {
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}
