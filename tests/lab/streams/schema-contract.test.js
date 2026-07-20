import { describe, expect, it } from "vitest";

import {
  detectTypeChanges,
  isRecordClean,
  validateRecord,
} from "../../../scripts/lab/streams/schema-contract.js";

const CONTRACT = Object.freeze({
  requiredNativeFields: ["_timestamp", "type", "service"],
  conditionalNativeFieldGroups: {
    view: ["view_id", "view_url"],
    error: ["error_id", "error_message"],
  },
  controlledFields: ["chicek_correlation_session_id", "chicek_policy_version", "test_run_id"],
  knownFieldTypes: {
    _timestamp: "Int64",
    type: "Utf8",
    service: "Utf8",
    view_id: "Utf8",
  },
  forbiddenFieldNames: ["password", "context"],
  forbiddenFieldNamePatterns: ["(?i)(^|_)cookie($|_)"],
  forbiddenValuePatterns: ["(?i)authorization"],
  urlFieldsMustNotContainQueryOrFragment: ["view_url"],
});

describe("validateRecord", () => {
  it("reports a fully clean, required-complete record as clean", () => {
    const record = {
      _timestamp: 123,
      type: "view",
      service: "demo",
      view_id: "v1",
      view_url: "https://example.test/page",
      chicek_correlation_session_id: "abc",
      test_run_id: "run-1",
    };
    const validation = validateRecord(CONTRACT, record);
    expect(isRecordClean(validation)).toBe(true);
    expect(validation.missingRequired).toEqual([]);
    expect(validation.unknownAdditive).toEqual([]);
  });

  it("reports every missing required field", () => {
    const validation = validateRecord(CONTRACT, { type: "view" });
    expect(validation.missingRequired.sort()).toEqual(["_timestamp", "service"]);
    expect(isRecordClean(validation)).toBe(false);
  });

  it("treats a non-object record as missing every required field, without throwing", () => {
    expect(() => validateRecord(CONTRACT, null)).not.toThrow();
    const validation = validateRecord(CONTRACT, null);
    expect(validation.missingRequired.sort()).toEqual(["_timestamp", "service", "type"]);
  });

  it("flags an exact forbidden field name", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      password: "hunter2",
    });
    expect(validation.forbiddenPresent).toEqual(["password"]);
    expect(isRecordClean(validation)).toBe(false);
  });

  it("flags a field matching a forbidden name pattern", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      request_cookie: "sid=abc",
    });
    expect(validation.forbiddenPatternMatches).toEqual(["request_cookie"]);
  });

  it("flags an uncontrolled chicek.*-shaped field", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      chicek_experimental_flag: "x",
    });
    expect(validation.uncontrolledChicek).toEqual(["chicek_experimental_flag"]);
  });

  it("does not flag a controlled chicek.* field", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      chicek_policy_version: "telemetry-sanitization-v1",
    });
    expect(validation.uncontrolledChicek).toEqual([]);
    expect(validation.unknownAdditive).toEqual([]);
  });

  it("classifies an unrecognized field as unknown-additive", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      brand_new_native_field: "x",
    });
    expect(validation.unknownAdditive).toEqual(["brand_new_native_field"]);
  });

  it("flags a value matching a forbidden value pattern", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      error_message: "Authorization header leaked",
    });
    expect(validation.valuePatternMatches).toEqual(["error_message"]);
  });

  it("flags a URL field carrying a query string or fragment", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      view_url: "https://example.test/page?token=abc",
    });
    expect(validation.urlLeaks).toEqual(["view_url"]);
  });

  it("does not flag a non-string value for value/url patterns", () => {
    const validation = validateRecord(CONTRACT, {
      _timestamp: 1,
      type: "view",
      service: "demo",
      view_url: 12345,
    });
    expect(validation.urlLeaks).toEqual([]);
    expect(validation.valuePatternMatches).toEqual([]);
  });

  it("works against a contract missing optional sections entirely", () => {
    const minimalContract = { requiredNativeFields: ["type"] };
    const validation = validateRecord(minimalContract, { type: "view", anything: "x" });
    expect(validation.unknownAdditive).toEqual(["anything"]);
    expect(validation.forbiddenPresent).toEqual([]);
  });

  it("treats a fully empty contract (no requiredNativeFields at all) as having nothing required", () => {
    const validation = validateRecord({}, { anything: "x" });
    expect(validation.missingRequired).toEqual([]);
    expect(validation.unknownAdditive).toEqual(["anything"]);
  });
});

describe("detectTypeChanges", () => {
  it("reports no changes when live schema types match knownFieldTypes", () => {
    const liveSchema = [
      { name: "_timestamp", type: "Int64" },
      { name: "type", type: "Utf8" },
    ];
    expect(detectTypeChanges(CONTRACT, liveSchema)).toEqual([]);
  });

  it("reports a type change for a known field with a different live type", () => {
    const liveSchema = [{ name: "_timestamp", type: "Utf8" }];
    expect(detectTypeChanges(CONTRACT, liveSchema)).toEqual([
      { field: "_timestamp", expectedType: "Int64", actualType: "Utf8" },
    ]);
  });

  it("ignores a live field that has no known type on record (new field, not a change)", () => {
    const liveSchema = [{ name: "brand_new_field", type: "Utf8" }];
    expect(detectTypeChanges(CONTRACT, liveSchema)).toEqual([]);
  });

  it("handles a missing/empty live schema and a contract with no knownFieldTypes", () => {
    expect(detectTypeChanges(CONTRACT, undefined)).toEqual([]);
    expect(detectTypeChanges({}, [{ name: "x", type: "Utf8" }])).toEqual([]);
  });
});
