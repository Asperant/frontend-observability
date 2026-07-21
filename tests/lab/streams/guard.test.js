import { describe, expect, it } from "vitest";

import {
  CANONICAL_ORG,
  CANONICAL_STREAMS,
  DISPOSABLE_STREAM_PREFIX,
  GUARD_REASON,
  generateDisposableStreamName,
  isDisposableStreamName,
  isNonDestructiveSettingsChange,
  validateDestructiveTarget,
} from "../../../scripts/lab/streams/guard.js";

describe("validateDestructiveTarget", () => {
  it("hard-blocks every canonical stream regardless of org/confirmation", () => {
    for (const streamName of CANONICAL_STREAMS) {
      const result = validateDestructiveTarget({ org: CANONICAL_ORG, streamName, confirmed: true });
      expect(result).toEqual({ allowed: false, reason: GUARD_REASON.CANONICAL_STREAM_BLOCKED });
    }
  });

  it("rejects a stream name that does not match the disposable prefix/shape", () => {
    const result = validateDestructiveTarget({
      org: CANONICAL_ORG,
      streamName: "some_other_stream",
      confirmed: true,
    });
    expect(result).toEqual({ allowed: false, reason: GUARD_REASON.NOT_DISPOSABLE_PREFIX });
  });

  it("rejects a non-string stream name", () => {
    const result = validateDestructiveTarget({
      org: CANONICAL_ORG,
      streamName: undefined,
      confirmed: true,
    });
    expect(result).toEqual({ allowed: false, reason: GUARD_REASON.NOT_DISPOSABLE_PREFIX });
  });

  it("rejects a disposable-shaped name with an unsafe suffix", () => {
    const result = validateDestructiveTarget({
      org: CANONICAL_ORG,
      streamName: "_chicek_lifecycle_test_../etc",
      confirmed: true,
    });
    expect(result).toEqual({ allowed: false, reason: GUARD_REASON.NOT_DISPOSABLE_PREFIX });
  });

  it("rejects an org other than the canonical lab org", () => {
    const result = validateDestructiveTarget({
      org: "other-org",
      streamName: `${DISPOSABLE_STREAM_PREFIX}run1`,
      confirmed: true,
    });
    expect(result).toEqual({ allowed: false, reason: GUARD_REASON.ORG_MISMATCH });
  });

  it("rejects an unconfirmed operation on an otherwise-valid disposable target", () => {
    const result = validateDestructiveTarget({
      org: CANONICAL_ORG,
      streamName: `${DISPOSABLE_STREAM_PREFIX}run1`,
      confirmed: false,
    });
    expect(result).toEqual({ allowed: false, reason: GUARD_REASON.CONFIRMATION_REQUIRED });
  });

  it("allows a confirmed, exact-org, disposable-shaped stream", () => {
    const result = validateDestructiveTarget({
      org: CANONICAL_ORG,
      streamName: `${DISPOSABLE_STREAM_PREFIX}run1`,
      confirmed: true,
    });
    expect(result).toEqual({ allowed: true, reason: GUARD_REASON.OK });
  });
});

describe("isNonDestructiveSettingsChange", () => {
  it("allows disabling store_original_data but not enabling it", () => {
    expect(isNonDestructiveSettingsChange("store_original_data", false)).toBe(true);
    expect(isNonDestructiveSettingsChange("store_original_data", true)).toBe(false);
  });

  it("allows non-negative integer retention/query-range values only", () => {
    expect(isNonDestructiveSettingsChange("data_retention", 7)).toBe(true);
    expect(isNonDestructiveSettingsChange("max_query_range", 168)).toBe(true);
    expect(isNonDestructiveSettingsChange("data_retention", -1)).toBe(false);
    expect(isNonDestructiveSettingsChange("data_retention", 1.5)).toBe(false);
  });

  it("allows only empty-array index/partition fields", () => {
    for (const field of [
      "full_text_search_keys",
      "index_fields",
      "bloom_filter_fields",
      "partition_keys",
      "distinct_value_fields",
    ]) {
      expect(isNonDestructiveSettingsChange(field, [])).toBe(true);
      expect(isNonDestructiveSettingsChange(field, ["message"])).toBe(false);
      expect(isNonDestructiveSettingsChange(field, "not-an-array")).toBe(false);
    }
  });

  it("allows distinct_value_fields to be set to exactly the low-cardinality [service, env] allowlist", () => {
    expect(isNonDestructiveSettingsChange("distinct_value_fields", ["service", "env"])).toBe(true);
  });

  it("refuses distinct_value_fields in the wrong order", () => {
    expect(isNonDestructiveSettingsChange("distinct_value_fields", ["env", "service"])).toBe(false);
  });

  it("refuses distinct_value_fields with an extra field beyond the allowlist", () => {
    expect(
      isNonDestructiveSettingsChange("distinct_value_fields", ["service", "env", "session_id"]),
    ).toBe(false);
  });

  it("refuses distinct_value_fields with the right length but a different field name", () => {
    expect(isNonDestructiveSettingsChange("distinct_value_fields", ["service", "session_id"])).toBe(
      false,
    );
  });

  it("rejects any field it does not recognize", () => {
    expect(isNonDestructiveSettingsChange("unknown_field", "value")).toBe(false);
  });
});

describe("isDisposableStreamName", () => {
  it("accepts the exact disposable shape and rejects everything else", () => {
    expect(isDisposableStreamName(`${DISPOSABLE_STREAM_PREFIX}abc123`)).toBe(true);
    expect(isDisposableStreamName("_rumdata")).toBe(false);
    expect(isDisposableStreamName(42)).toBe(false);
  });
});

describe("generateDisposableStreamName", () => {
  it("strips unsafe characters from the run id and applies the fixed prefix", () => {
    const name = generateDisposableStreamName("run/1 (canary)!");
    expect(name.startsWith(DISPOSABLE_STREAM_PREFIX)).toBe(true);
    expect(isDisposableStreamName(name)).toBe(true);
    expect(name).toBe(`${DISPOSABLE_STREAM_PREFIX}run1canary`);
  });

  it("bounds the generated name length", () => {
    const name = generateDisposableStreamName("x".repeat(500));
    expect(name.length).toBeLessThanOrEqual(104);
  });

  it("throws if the run id has no safe characters at all", () => {
    expect(() => generateDisposableStreamName("///???")).toThrow();
  });
});
