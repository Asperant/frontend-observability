import { isDocumentLive } from "./document-lifetime.js";
import { ensureControlRegistry } from "./registry.js";

/**
 * The browser collection gate: computed fresh on every call from the
 * page-lifetime control registry, never a value that has to be separately
 * "pushed" by the refresh loop. This is deliberate: it means the gate closes
 * itself the instant the last-known-good document's own expiresAt lapses,
 * even if the refresh loop's next tick hasn't fired yet, and it means the
 * gate holds no state of its own beyond what ensureControlRegistry()
 * already tracks — never a payload, URL, token, or consent value.
 */
export function isCollectionGateOpen(now = new Date()) {
  const registry = ensureControlRegistry();
  if (!registry.hasAppliedOnce) return false;
  if (registry.killSwitchLatched) return false;
  return isDocumentLive(registry.currentDocument, now);
}
