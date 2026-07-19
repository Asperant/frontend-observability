const HEX_CHARS = "0123456789abcdef";

// Length-prefixes every field with its own UTF-8 byte length before
// concatenating them (a netstring-style encoding: "<len>:<value>" per
// field, back to back with no separator between fields). This is what
// makes the canonicalization collision-safe: a naive "a|b|c" join would let
// a value containing "|" make two different configs collide (e.g.
// site="x|y", org="z" canonicalizing the same as site="x", org="y|z"); with
// an explicit byte-length prefix per field, the only way two distinct field
// sequences can produce the same canonical string is for every field to be
// byte-for-byte identical.
function encodeCanonical(fields) {
  const encoder = new TextEncoder();
  let canonical = "";
  for (const field of fields) {
    const value = String(field);
    const length = encoder.encode(value).length;
    canonical += `${length}:${value}`;
  }
  return canonical;
}

function toHex(digest) {
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    hex += HEX_CHARS[byte >> 4] + HEX_CHARS[byte & 0x0f];
  }
  return hex;
}

export function isFingerprintingSupported() {
  return typeof globalThis.crypto?.subtle?.digest === "function";
}

/**
 * Identifies "which real OpenObserve SDK connection" an adapter initialize()
 * call is asking for, from exactly the fields that determine what the
 * already-initialized vendor SDK singleton is actually configured to talk
 * to: the RUM connection (site/organizationIdentifier/applicationId/token)
 * plus the host identity tags (service/environment/version) baked into the
 * SDK's init options. Two calls with the same fingerprint are the same
 * logical connection and can safely resume the existing SDK singleton;
 * anything else cannot, because the vendor SDK has no API to reconfigure an
 * already-initialized instance — this is a security-relevant decision, so
 * the fingerprint is a SHA-256 digest of a collision-safe canonical
 * encoding (see encodeCanonical above), computed via the real Web Crypto
 * API. Only the digest is ever returned; the clientToken and the canonical
 * plaintext built from it are local to this call and are not retained
 * anywhere.
 *
 * Throws if `crypto.subtle` is unavailable in this runtime rather than
 * falling back to a weaker hash — callers must treat that as a fail-closed
 * initialization failure, not silently proceed without collision safety.
 */
export async function computeSdkFingerprint(identity, rumConfig) {
  if (!isFingerprintingSupported()) {
    throw new Error("SHA-256 fingerprinting (crypto.subtle) is not available in this runtime");
  }
  const canonical = encodeCanonical([
    rumConfig.site,
    rumConfig.organizationIdentifier,
    rumConfig.applicationId,
    rumConfig.clientToken,
    identity.service,
    identity.environment,
    identity.version,
  ]);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return toHex(digest);
}
