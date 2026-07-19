export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
export const LONG_NUMERIC_PATTERN = /\b\d{9,}\b/g;
export const PHONE_PATTERN = /\+?\b(?:\d[\s().-]?){10,15}\d\b/g;
export const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
export const CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
export const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
export const BASE64_TOKEN_PATTERN = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;
export const ASSET_HASH_PATTERN = /\b[A-Fa-f0-9]{8,64}\b/g;

export const SECRET_PATTERNS = Object.freeze([
  /\bAuthorization\s*:/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bCookie\s*:/i,
  /\bSet-Cookie\s*:/i,
  /\b(api[_-]?key|secret|password|token)\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);
