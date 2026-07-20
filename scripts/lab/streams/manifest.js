// Pure normalization/diff of an OpenObserve stream's real
// `settings` object (as returned by
// `GET /api/{org}/streams/{stream}/schema?type=logs` — see
// docs/openobserve-v0.91-stream-capabilities.md capability #6) against a
// desired-state manifest (infrastructure/openobserve/streams/*.stream.json).
// No I/O here: reading the manifest file and calling the admin API both
// live in scripts/lab/streams-*.mjs.

// Exact reserved property names: a raw server JSON response that happens to
// contain an own "__proto__" key (e.g. a compromised/MITM'd OpenObserve
// response) would otherwise reshape `normalized`'s prototype via the
// bracket assignment below instead of storing a data property.
const RESERVED_OBJECT_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

const MANAGED_FIELDS = Object.freeze([
  "data_retention",
  "max_query_range",
  "store_original_data",
  "full_text_search_keys",
  "index_fields",
  "bloom_filter_fields",
  "partition_keys",
  "distinct_value_fields",
]);

/**
 * The real API returns an empty `partition_keys` as `{}` (an object) but
 * every other empty managed field as `[]` (see capability #6/#7b). Both
 * mean "no custom value set" and must compare as equal to a manifest's
 * `[]`. Every other managed field is compared as-is.
 */
function normalizeManagedValue(field, value) {
  if (field === "partition_keys") {
    if (Array.isArray(value)) return value.length === 0 ? [] : value;
    if (value && typeof value === "object") return Object.keys(value).length === 0 ? [] : value;
    return value;
  }
  return value;
}

/**
 * Strips a stream manifest's declared `volatileServerFields` (server-owned
 * bookkeeping such as `index_updated_at`) out of a raw server `settings`
 * object, and normalizes the remaining managed fields, so the result can be
 * diffed 1:1 against `manifest.desiredSettings`.
 */
export function normalizeServerSettings(rawSettings, volatileServerFields = []) {
  const normalized = {};
  for (const field of MANAGED_FIELDS) {
    if (!(field in rawSettings)) continue;
    normalized[field] = normalizeManagedValue(field, rawSettings[field]);
  }
  for (const field of Object.keys(rawSettings)) {
    if (MANAGED_FIELDS.includes(field)) continue;
    if (volatileServerFields.includes(field)) continue;
    if (RESERVED_OBJECT_KEYS.includes(field)) continue;
    normalized[field] = rawSettings[field];
  }
  return normalized;
}

function deepEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
      return false;
    }
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return a === b;
}

/**
 * Diffs a manifest's `desiredSettings` against an already-normalized actual
 * settings object (see normalizeServerSettings). Only ever inspects the
 * managed field set — a real server settings object commonly has fields
 * the manifest doesn't manage yet (already excluded by
 * normalizeServerSettings unless present in volatileServerFields), which is
 * intentionally not an error here (that is the schema/drift layer's job,
 * not the manifest diff's).
 */
export function diffSettings(desiredSettings, normalizedActualSettings) {
  const diffs = [];
  for (const field of MANAGED_FIELDS) {
    if (!(field in desiredSettings)) continue;
    const desired = desiredSettings[field];
    const actual = normalizedActualSettings[field];
    if (!deepEqual(desired, actual)) {
      diffs.push({ field, desired, actual });
    }
  }
  return diffs;
}

export function isNoChange(diffs) {
  return diffs.length === 0;
}

export { MANAGED_FIELDS };
