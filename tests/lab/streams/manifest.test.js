import { describe, expect, it } from "vitest";

import {
  diffSettings,
  isNoChange,
  normalizeServerSettings,
} from "../../../scripts/lab/streams/manifest.js";

const VOLATILE_FIELDS = [
  "approx_partition",
  "index_updated_at",
  "index_fields_updated_at",
  "extended_retention_days",
  "index_original_data",
  "index_all_values",
  "enable_distinct_fields",
  "enable_log_patterns_extraction",
  "is_llm_stream",
  "storage_type",
];

const REAL_SERVER_SETTINGS = Object.freeze({
  partition_keys: {},
  full_text_search_keys: [],
  index_fields: [],
  bloom_filter_fields: [],
  distinct_value_fields: [],
  data_retention: 7,
  max_query_range: 168,
  store_original_data: false,
  approx_partition: false,
  index_updated_at: 0,
  extended_retention_days: [],
  index_original_data: false,
  index_all_values: false,
  enable_distinct_fields: true,
  enable_log_patterns_extraction: false,
  is_llm_stream: false,
  storage_type: "normal",
});

const DESIRED_SETTINGS = Object.freeze({
  data_retention: 7,
  max_query_range: 168,
  store_original_data: false,
  full_text_search_keys: [],
  index_fields: [],
  bloom_filter_fields: [],
  partition_keys: [],
  distinct_value_fields: [],
});

describe("normalizeServerSettings", () => {
  it("normalizes an empty partition_keys object to an empty array", () => {
    const normalized = normalizeServerSettings(REAL_SERVER_SETTINGS, VOLATILE_FIELDS);
    expect(normalized.partition_keys).toEqual([]);
  });

  it("leaves a non-empty partition_keys object/array untouched", () => {
    const withArray = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: ["level"] },
      VOLATILE_FIELDS,
    );
    expect(withArray.partition_keys).toEqual(["level"]);

    const withObject = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: { level: ["level"] } },
      VOLATILE_FIELDS,
    );
    expect(withObject.partition_keys).toEqual({ level: ["level"] });
  });

  it("normalizes an empty partition_keys array to itself", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: [] },
      VOLATILE_FIELDS,
    );
    expect(normalized.partition_keys).toEqual([]);
  });

  it("passes through a scalar/unexpected partition_keys value unchanged", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: null },
      VOLATILE_FIELDS,
    );
    expect(normalized.partition_keys).toBeNull();
  });

  it("strips declared volatile server fields", () => {
    const normalized = normalizeServerSettings(REAL_SERVER_SETTINGS, VOLATILE_FIELDS);
    for (const field of VOLATILE_FIELDS) {
      expect(normalized).not.toHaveProperty(field);
    }
  });

  it("keeps unmanaged, non-volatile fields untouched (forward-compatibility)", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, some_future_field: "x" },
      VOLATILE_FIELDS,
    );
    expect(normalized.some_future_field).toBe("x");
  });

  it("defaults volatileServerFields to empty when omitted", () => {
    const normalized = normalizeServerSettings(REAL_SERVER_SETTINGS);
    expect(normalized).toHaveProperty("approx_partition");
  });

  it("skips a managed field that is entirely absent from the raw server settings", () => {
    const { distinct_value_fields: _omit, ...rawWithoutDistinctValueFields } = REAL_SERVER_SETTINGS;
    const normalized = normalizeServerSettings(rawWithoutDistinctValueFields, VOLATILE_FIELDS);
    expect(normalized).not.toHaveProperty("distinct_value_fields");
  });

  it("strips the server-assigned added_ts from a populated distinct_value_fields, keeping just names", () => {
    const normalized = normalizeServerSettings(
      {
        ...REAL_SERVER_SETTINGS,
        distinct_value_fields: [
          { name: "service", added_ts: 1111 },
          { name: "env", added_ts: 2222 },
        ],
      },
      VOLATILE_FIELDS,
    );
    expect(normalized.distinct_value_fields).toEqual(["service", "env"]);
  });

  it("leaves an already-flat distinct_value_fields string array untouched", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, distinct_value_fields: ["service"] },
      VOLATILE_FIELDS,
    );
    expect(normalized.distinct_value_fields).toEqual(["service"]);
  });

  it("passes through a distinct_value_fields entry that is an object without a name key", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, distinct_value_fields: [{ other: "x" }] },
      VOLATILE_FIELDS,
    );
    expect(normalized.distinct_value_fields).toEqual([{ other: "x" }]);
  });

  it("passes through a non-array distinct_value_fields value unchanged", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, distinct_value_fields: null },
      VOLATILE_FIELDS,
    );
    expect(normalized.distinct_value_fields).toBeNull();
  });

  it("drops an own __proto__ key from a raw server response instead of letting it change the normalized object's prototype", () => {
    const attackerResponse = JSON.parse('{"__proto__": {"polluted": true}, "custom_field": "ok"}');
    const normalized = normalizeServerSettings(attackerResponse, VOLATILE_FIELDS);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(normalized.custom_field).toBe("ok");
    expect(normalized.polluted).toBeUndefined();
  });
});

describe("diffSettings", () => {
  it("reports no diff when actual matches desired exactly", () => {
    const normalized = normalizeServerSettings(REAL_SERVER_SETTINGS, VOLATILE_FIELDS);
    const diffs = diffSettings(DESIRED_SETTINGS, normalized);
    expect(diffs).toEqual([]);
    expect(isNoChange(diffs)).toBe(true);
  });

  it("reports a diff for a scalar field mismatch", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, data_retention: 30 },
      VOLATILE_FIELDS,
    );
    const diffs = diffSettings(DESIRED_SETTINGS, normalized);
    expect(diffs).toEqual([{ field: "data_retention", desired: 7, actual: 30 }]);
    expect(isNoChange(diffs)).toBe(false);
  });

  it("reports a diff for store_original_data drifting to true", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, store_original_data: true },
      VOLATILE_FIELDS,
    );
    const diffs = diffSettings(DESIRED_SETTINGS, normalized);
    expect(diffs).toEqual([{ field: "store_original_data", desired: false, actual: true }]);
  });

  it("reports a diff for an array field with different contents", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, full_text_search_keys: ["message"] },
      VOLATILE_FIELDS,
    );
    const diffs = diffSettings(DESIRED_SETTINGS, normalized);
    expect(diffs).toEqual([{ field: "full_text_search_keys", desired: [], actual: ["message"] }]);
  });

  it("skips a managed field the manifest does not declare a desired value for", () => {
    const { data_retention: _omit, ...partialDesired } = DESIRED_SETTINGS;
    const normalized = normalizeServerSettings(REAL_SERVER_SETTINGS, VOLATILE_FIELDS);
    const diffs = diffSettings(partialDesired, normalized);
    expect(diffs.find((diff) => diff.field === "data_retention")).toBeUndefined();
  });

  it("reports a diff between an empty desired array and a non-empty actual partition_keys object", () => {
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: { level: ["level"] } },
      VOLATILE_FIELDS,
    );
    const diffs = diffSettings(DESIRED_SETTINGS, normalized);
    expect(diffs).toEqual([{ field: "partition_keys", desired: [], actual: { level: ["level"] } }]);
  });

  it("reports no diff when desired and actual partition_keys are equal non-empty objects", () => {
    const desired = { ...DESIRED_SETTINGS, partition_keys: { level: ["level"] } };
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: { level: ["level"] } },
      VOLATILE_FIELDS,
    );
    expect(diffSettings(desired, normalized)).toEqual([]);
  });

  it("reports a diff when partition_keys objects have the same key count but different key names", () => {
    const desired = { ...DESIRED_SETTINGS, partition_keys: { level: ["a"] } };
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: { region: ["a"] } },
      VOLATILE_FIELDS,
    );
    const diffs = diffSettings(desired, normalized);
    expect(diffs).toEqual([
      { field: "partition_keys", desired: { level: ["a"] }, actual: { region: ["a"] } },
    ]);
  });

  it("reports no diff for the _rumdata distinct_value_fields allowlist once actual matches it", () => {
    const desired = { ...DESIRED_SETTINGS, distinct_value_fields: ["service", "env"] };
    const normalized = normalizeServerSettings(
      {
        ...REAL_SERVER_SETTINGS,
        distinct_value_fields: [
          { name: "service", added_ts: 1111 },
          { name: "env", added_ts: 2222 },
        ],
      },
      VOLATILE_FIELDS,
    );
    expect(diffSettings(desired, normalized)).toEqual([]);
  });

  it("reports a diff when partition_keys objects share keys but differ in nested value", () => {
    const desired = { ...DESIRED_SETTINGS, partition_keys: { level: ["a"] } };
    const normalized = normalizeServerSettings(
      { ...REAL_SERVER_SETTINGS, partition_keys: { level: ["b"] } },
      VOLATILE_FIELDS,
    );
    const diffs = diffSettings(desired, normalized);
    expect(diffs).toEqual([
      { field: "partition_keys", desired: { level: ["a"] }, actual: { level: ["b"] } },
    ]);
  });
});
