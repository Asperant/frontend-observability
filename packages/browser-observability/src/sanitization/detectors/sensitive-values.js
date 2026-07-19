import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { PLACEHOLDERS } from "../policy/baseline.js";
import {
  BASE64_TOKEN_PATTERN,
  CARD_PATTERN,
  EMAIL_PATTERN,
  IBAN_PATTERN,
  JWT_PATTERN,
  LONG_NUMERIC_PATTERN,
  PHONE_PATTERN,
  SECRET_PATTERNS,
  UUID_PATTERN,
} from "./patterns.js";

export function containsSecret(value) {
  if (typeof value !== "string") return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactSensitiveText(value) {
  let output = String(value);
  const reasons = [];

  if (containsSecret(output)) {
    return { drop: true, text: "", reasons: [ReasonCodes.SECRET_DETECTED] };
  }

  output = replaceAndReason(output, EMAIL_PATTERN, PLACEHOLDERS.email, reasons);
  output = replaceAndReason(output, IBAN_PATTERN, PLACEHOLDERS.iban, reasons);
  output = replaceAndReason(output, CARD_PATTERN, PLACEHOLDERS.card, reasons);
  output = replaceAndReason(output, PHONE_PATTERN, PLACEHOLDERS.phone, reasons);
  output = replaceAndReason(output, JWT_PATTERN, PLACEHOLDERS.token, reasons);
  output = replaceAndReason(output, UUID_PATTERN, PLACEHOLDERS.uuid, reasons);
  output = replaceAndReason(output, LONG_NUMERIC_PATTERN, PLACEHOLDERS.identifier, reasons);
  output = replaceAndReason(output, BASE64_TOKEN_PATTERN, PLACEHOLDERS.token, reasons);

  return { drop: false, text: output, reasons };
}

export function hasHighRiskIdentifier(value) {
  if (typeof value !== "string") return false;
  return (
    matches(EMAIL_PATTERN, value) ||
    matches(UUID_PATTERN, value) ||
    matches(LONG_NUMERIC_PATTERN, value) ||
    matches(JWT_PATTERN, value) ||
    matches(BASE64_TOKEN_PATTERN, value) ||
    containsSecret(value)
  );
}

function matches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function replaceAndReason(value, pattern, placeholder, reasons) {
  pattern.lastIndex = 0;
  if (!pattern.test(value)) return value;
  pattern.lastIndex = 0;
  reasons.push(ReasonCodes.PII_REDACTED);
  return value.replace(pattern, placeholder);
}
