// Pure destructive-operation guard for OpenObserve stream lifecycle
// operations. No I/O: callers (scripts/lab/streams-provision.mjs,
// scripts/lab/verify-streams.mjs) are responsible for actually
// performing or refusing the HTTP call based on this module's verdict.

export const CANONICAL_STREAMS = Object.freeze(["_rumdata", "_rumlog"]);
export const CANONICAL_ORG = "default";
export const DISPOSABLE_STREAM_PREFIX = "_chicek_lifecycle_test_";

// Bounded: a run-id suffix long enough to be collision-safe, short enough
// to reject obviously-malformed/injected input.
const DISPOSABLE_STREAM_PATTERN = /^_chicek_lifecycle_test_[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export const GUARD_REASON = Object.freeze({
  OK: "OK",
  CANONICAL_STREAM_BLOCKED: "CANONICAL_STREAM_BLOCKED",
  NOT_DISPOSABLE_PREFIX: "NOT_DISPOSABLE_PREFIX",
  ORG_MISMATCH: "ORG_MISMATCH",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
});

/**
 * Decides whether a destructive operation (stream delete, or any settings
 * write that would disable UDS/store-original protections — see
 * isNonDestructiveSettingsChange) may proceed against `streamName` in
 * `org`. Canonical streams are hard-blocked unconditionally: there is no
 * confirmation flag, option, or org override that admits them here. A
 * non-canonical stream is only ever admitted if its name matches the exact
 * disposable-lifecycle-test prefix/shape, the org is the exact lab org, and
 * the caller has explicitly confirmed.
 *
 * Returns a plain, JSON-serializable verdict rather than throwing, so
 * callers can log/report the reason before deciding whether to abort.
 */
export function validateDestructiveTarget({ org, streamName, confirmed }) {
  if (CANONICAL_STREAMS.includes(streamName)) {
    return { allowed: false, reason: GUARD_REASON.CANONICAL_STREAM_BLOCKED };
  }
  if (typeof streamName !== "string" || !DISPOSABLE_STREAM_PATTERN.test(streamName)) {
    return { allowed: false, reason: GUARD_REASON.NOT_DISPOSABLE_PREFIX };
  }
  if (org !== CANONICAL_ORG) {
    return { allowed: false, reason: GUARD_REASON.ORG_MISMATCH };
  }
  if (confirmed !== true) {
    return { allowed: false, reason: GUARD_REASON.CONFIRMATION_REQUIRED };
  }
  return { allowed: true, reason: GUARD_REASON.OK };
}

// The only distinct_value_fields value (besides clearing to `[]`) automatic
// provisioning may ever write. `service`/`env` are bounded, single-value
// identity fields in this lab (tests/fixtures/apps/browser-app/src/identity.js), not
// unbounded/high-cardinality data — see
// docs/openobserve-stream-schema-lifecycle.md#index-and-partition-decision
// for why this specific pair was allowlisted instead of the empty default.
// Order matters: this must match the exact order the pinned OpenObserve
// build already returned once both names were added (verified against the
// real _rumdata stream), since manifest.js's diff is order-sensitive.
const LOW_CARDINALITY_DISTINCT_VALUE_FIELDS = Object.freeze(["service", "env"]);

/**
 * True only for the exact settings fields stream-lifecycle provisioning is allowed
 * to change automatically (§5 of the roadmap task): a value can never
 * enable UDS/store_original_data, change a field's type (not representable
 * as a settings-only change at all), remove a field, or delete
 * data — those are refused elsewhere (drift classification / the guard
 * above), not here. This function only says "this specific field/value is
 * the kind of thing safe automatic provisioning is allowed to write".
 */
export function isNonDestructiveSettingsChange(field, nextValue) {
  if (field === "store_original_data") return nextValue === false;
  if (field === "data_retention" || field === "max_query_range") {
    return Number.isInteger(nextValue) && nextValue >= 0;
  }
  if (field === "distinct_value_fields") {
    if (!Array.isArray(nextValue)) return false;
    if (nextValue.length === 0) return true;
    return (
      nextValue.length === LOW_CARDINALITY_DISTINCT_VALUE_FIELDS.length &&
      nextValue.every((name, index) => name === LOW_CARDINALITY_DISTINCT_VALUE_FIELDS[index])
    );
  }
  if (
    field === "full_text_search_keys" ||
    field === "index_fields" ||
    field === "bloom_filter_fields" ||
    field === "partition_keys"
  ) {
    return Array.isArray(nextValue) && nextValue.length === 0;
  }
  return false;
}

export function isDisposableStreamName(streamName) {
  return typeof streamName === "string" && DISPOSABLE_STREAM_PATTERN.test(streamName);
}

export function generateDisposableStreamName(runId) {
  const safeRunId = String(runId).replace(/[^A-Za-z0-9_-]/g, "");
  if (safeRunId.length === 0) {
    throw new Error("generateDisposableStreamName requires a non-empty, safe runId.");
  }
  const name = `${DISPOSABLE_STREAM_PREFIX}${safeRunId}`;
  return name.slice(0, 104);
}
