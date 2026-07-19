import { RuntimeControlStates } from "./constants.js";
import { isDocumentLive } from "./document-lifetime.js";
import { ControlReasonCodes } from "./validate-document.js";

// Fetch/transport-layer failures (endpoint unreachable, timed out, wrong
// content-type, oversized, malformed JSON) are distinct from a
// structurally-valid-but-rejected *document* (bad schema, duplicate key,
// unknown field, bad revision/lifetime). Only the latter increments
// `invalidRejected`; the former increments `refreshFailed`.
const DOCUMENT_INVALID_REASON_CODES = new Set(Object.values(ControlReasonCodes));

/**
 * Applies one fetchControlDocument() outcome to the registry: revision
 * comparison + monotonic latch semantics (section 5), degraded/expired
 * fail-closed bookkeeping (section 4), and kill-switch latching (section 6).
 * Pure with respect to its inputs beyond the registry object it mutates —
 * always deterministic for a given (registry, fetchResult, now).
 */
export function applyFetchOutcome(registry, fetchResult, now = new Date()) {
  registry.lastCheckedAt = now.toISOString();

  if (!fetchResult.ok) {
    return handleFailure(registry, fetchResult.reasonCode, now);
  }

  const document = fetchResult.document;
  const currentRevision = registry.currentDocument?.revision ?? -1;

  if (document.revision < currentRevision) {
    registry.consecutiveFailures += 1;
    registry.counters.rollbackRejected += 1;
    registry.lastOutcomeState = RuntimeControlStates.ROLLBACK_REJECTED;
    return { shouldBackoff: true };
  }

  registry.consecutiveFailures = 0;
  registry.counters.refreshSucceeded += 1;

  if (document.revision === currentRevision) {
    registry.lastOutcomeState = RuntimeControlStates.FRESH;
    return { shouldBackoff: false };
  }

  registry.currentDocument = document;
  registry.lastAppliedAt = now.toISOString();
  registry.hasAppliedOnce = true;
  registry.lastOutcomeState = RuntimeControlStates.FRESH;
  applyKillSwitch(registry, document.killSwitch);
  return { shouldBackoff: false };
}

function handleFailure(registry, reasonCode, now) {
  registry.consecutiveFailures += 1;

  if (DOCUMENT_INVALID_REASON_CODES.has(reasonCode)) {
    registry.counters.invalidRejected += 1;
    registry.lastOutcomeState = RuntimeControlStates.INVALID;
    return { shouldBackoff: true };
  }

  registry.counters.refreshFailed += 1;
  const cacheStillLive = registry.hasAppliedOnce && isDocumentLive(registry.currentDocument, now);
  if (!cacheStillLive) {
    registry.counters.expiredFailClosed += 1;
    registry.lastOutcomeState = RuntimeControlStates.EXPIRED;
  } else {
    registry.lastOutcomeState = RuntimeControlStates.DEGRADED;
  }
  return { shouldBackoff: true };
}

function applyKillSwitch(registry, killSwitch) {
  if (registry.killSwitchLatched) {
    // Latched for the rest of this page's lifetime: the newly-applied
    // document's revision bookkeeping still advances above, but the
    // effective kill-switch state can never flip back to inactive here —
    // only a full page reload clears the latch (see registry.js).
    return;
  }
  registry.killSwitchActive = killSwitch.active;
  registry.killSwitchReasonCode = killSwitch.reasonCode;
  if (killSwitch.active) {
    registry.killSwitchLatched = true;
    registry.counters.killSwitchActivated += 1;
  }
}

/**
 * Derives the externally-visible runtimeControl.state from current registry
 * facts + wall clock, rather than trusting a value written during the last
 * refresh cycle — so an expiry that lapses between refresh ticks is still
 * reported correctly (and the gate, computed independently in gate.js the
 * same way, is always consistent with this).
 */
export function computeRuntimeControlState(registry, now = new Date()) {
  if (registry.killSwitchLatched) return RuntimeControlStates.KILL_SWITCHED;
  if (!registry.hasAppliedOnce) return registry.lastOutcomeState ?? RuntimeControlStates.EXPIRED;
  if (!isDocumentLive(registry.currentDocument, now)) return RuntimeControlStates.EXPIRED;
  if (registry.currentlyRefreshing) return RuntimeControlStates.REFRESHING;
  return registry.lastOutcomeState ?? RuntimeControlStates.FRESH;
}
