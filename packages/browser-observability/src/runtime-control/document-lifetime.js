export function isDocumentLive(document, now = new Date()) {
  if (!document) return false;
  const expiresAtMs = Date.parse(document.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs > now.getTime();
}
