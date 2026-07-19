const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Non-cryptographic string hash. This exists only to fold a variable-length
// clientToken into a short, fixed-size fingerprint component so the token
// itself is never retained anywhere (registry/status/diagnostics/adapter
// state) beyond the single init() call that needs it — it is not a security
// control, and callers must never treat two matching hashes as proof of
// token possession.
function fnv1aHex(input) {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
 * already-initialized instance.
 */
export function computeSdkFingerprint(identity, rumConfig) {
  return [
    rumConfig.site,
    rumConfig.organizationIdentifier,
    rumConfig.applicationId,
    fnv1aHex(rumConfig.clientToken),
    identity.service,
    identity.environment,
    identity.version,
  ].join("|");
}
