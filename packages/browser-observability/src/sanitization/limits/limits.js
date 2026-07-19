export const LIMITS = Object.freeze({
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
