import { describe, expect, it } from "vitest";

import {
  DRIFT_CLASS,
  MAX_SAFE_ADDITIVE_FIELDS_PER_CANARY,
  classifyDrift,
  classifyPipelineDestination,
  classifySchemaFindings,
  classifySettingsDiff,
} from "../../../scripts/lab/streams/drift.js";

const CLEAN_VALIDATION = Object.freeze({
  missingRequired: [],
  forbiddenPresent: [],
  forbiddenPatternMatches: [],
  uncontrolledFrontendObservability: [],
  unknownAdditive: [],
  urlLeaks: [],
  valuePatternMatches: [],
});

describe("classifySettingsDiff", () => {
  it("classifies store_original_data drifting to true as SECURITY_DRIFT", () => {
    expect(
      classifySettingsDiff({ field: "store_original_data", desired: false, actual: true }),
    ).toBe(DRIFT_CLASS.SECURITY_DRIFT);
  });

  it("classifies store_original_data not being true (e.g. drifting to a falsy junk value) outside SECURITY_DRIFT", () => {
    expect(
      classifySettingsDiff({ field: "store_original_data", desired: true, actual: false }),
    ).toBe(DRIFT_CLASS.SETTINGS_DRIFT);
  });

  it("classifies retention/query-range fields as RETENTION_DRIFT", () => {
    expect(classifySettingsDiff({ field: "data_retention", desired: 7, actual: 30 })).toBe(
      DRIFT_CLASS.RETENTION_DRIFT,
    );
    expect(classifySettingsDiff({ field: "max_query_range", desired: 168, actual: 24 })).toBe(
      DRIFT_CLASS.RETENTION_DRIFT,
    );
  });

  it("classifies index/partition fields as INDEX_DRIFT", () => {
    expect(
      classifySettingsDiff({ field: "full_text_search_keys", desired: [], actual: ["message"] }),
    ).toBe(DRIFT_CLASS.INDEX_DRIFT);
  });

  it("classifies any other field as generic SETTINGS_DRIFT", () => {
    expect(classifySettingsDiff({ field: "some_future_field", desired: 1, actual: 2 })).toBe(
      DRIFT_CLASS.SETTINGS_DRIFT,
    );
  });
});

describe("classifySchemaFindings", () => {
  it("returns no classes for a clean validation with no type changes", () => {
    expect(classifySchemaFindings(CLEAN_VALIDATION)).toEqual([]);
  });

  it("classifies a forbidden-name finding as SECURITY_DRIFT", () => {
    const validation = { ...CLEAN_VALIDATION, forbiddenPresent: ["password"] };
    expect(classifySchemaFindings(validation)).toEqual([DRIFT_CLASS.SECURITY_DRIFT]);
  });

  it("classifies a forbidden-pattern/url-leak/value-pattern finding as SECURITY_DRIFT", () => {
    expect(
      classifySchemaFindings({ ...CLEAN_VALIDATION, forbiddenPatternMatches: ["x_cookie"] }),
    ).toEqual([DRIFT_CLASS.SECURITY_DRIFT]);
    expect(classifySchemaFindings({ ...CLEAN_VALIDATION, urlLeaks: ["view_url"] })).toEqual([
      DRIFT_CLASS.SECURITY_DRIFT,
    ]);
    expect(
      classifySchemaFindings({ ...CLEAN_VALIDATION, valuePatternMatches: ["error_message"] }),
    ).toEqual([DRIFT_CLASS.SECURITY_DRIFT]);
  });

  it("classifies a missing required field as BREAKING_SCHEMA_DRIFT", () => {
    const validation = { ...CLEAN_VALIDATION, missingRequired: ["service"] };
    expect(classifySchemaFindings(validation)).toEqual([DRIFT_CLASS.BREAKING_SCHEMA_DRIFT]);
  });

  it("classifies an uncontrolled frontend-observability.* field as BREAKING_SCHEMA_DRIFT", () => {
    const validation = {
      ...CLEAN_VALIDATION,
      uncontrolledFrontendObservability: ["frontend_observability_experimental"],
    };
    expect(classifySchemaFindings(validation)).toEqual([DRIFT_CLASS.BREAKING_SCHEMA_DRIFT]);
  });

  it("classifies a type change as BREAKING_SCHEMA_DRIFT", () => {
    const typeChanges = [{ field: "_timestamp", expectedType: "Int64", actualType: "Utf8" }];
    expect(classifySchemaFindings(CLEAN_VALIDATION, typeChanges)).toEqual([
      DRIFT_CLASS.BREAKING_SCHEMA_DRIFT,
    ]);
  });

  it("classifies a bounded number of unknown-additive fields as SAFE_ADDITIVE_NATIVE_DRIFT", () => {
    const validation = { ...CLEAN_VALIDATION, unknownAdditive: ["new_metric"] };
    expect(classifySchemaFindings(validation)).toEqual([DRIFT_CLASS.SAFE_ADDITIVE_NATIVE_DRIFT]);
  });

  it("classifies an unbounded burst of unknown-additive fields as BREAKING_SCHEMA_DRIFT instead", () => {
    const unknownAdditive = Array.from(
      { length: MAX_SAFE_ADDITIVE_FIELDS_PER_CANARY + 1 },
      (_, index) => `field_${index}`,
    );
    const validation = { ...CLEAN_VALIDATION, unknownAdditive };
    expect(classifySchemaFindings(validation)).toEqual([DRIFT_CLASS.BREAKING_SCHEMA_DRIFT]);
  });

  it("can report both SECURITY_DRIFT and BREAKING_SCHEMA_DRIFT together", () => {
    const validation = {
      ...CLEAN_VALIDATION,
      forbiddenPresent: ["password"],
      missingRequired: ["service"],
    };
    expect(classifySchemaFindings(validation).sort()).toEqual(
      [DRIFT_CLASS.SECURITY_DRIFT, DRIFT_CLASS.BREAKING_SCHEMA_DRIFT].sort(),
    );
  });
});

describe("classifyPipelineDestination", () => {
  const validPipeline = {
    source: { source_type: "realtime", stream_name: "_rumdata" },
    nodes: [
      { data: { node_type: "stream", stream_name: "_rumdata" }, io_type: "input" },
      { data: { node_type: "stream", stream_name: "_rumdata" }, io_type: "output" },
    ],
  };

  it("returns no findings when source and destination both match", () => {
    expect(classifyPipelineDestination(validPipeline, "_rumdata")).toEqual([]);
  });

  it("flags a mismatched source stream", () => {
    const pipeline = {
      ...validPipeline,
      source: { ...validPipeline.source, stream_name: "_other" },
    };
    expect(classifyPipelineDestination(pipeline, "_rumdata")).toEqual([
      DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT,
    ]);
  });

  it("flags a mismatched destination node", () => {
    const pipeline = {
      ...validPipeline,
      nodes: [
        { data: { node_type: "stream", stream_name: "_rumdata" }, io_type: "input" },
        { data: { node_type: "stream", stream_name: "_other" }, io_type: "output" },
      ],
    };
    expect(classifyPipelineDestination(pipeline, "_rumdata")).toEqual([
      DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT,
    ]);
  });

  it("flags a pipeline with no output stream node at all", () => {
    const pipeline = { ...validPipeline, nodes: [validPipeline.nodes[0]] };
    expect(classifyPipelineDestination(pipeline, "_rumdata")).toEqual([
      DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT,
    ]);
  });

  it("handles a completely missing/malformed pipeline without throwing", () => {
    expect(() => classifyPipelineDestination(undefined, "_rumdata")).not.toThrow();
    expect(classifyPipelineDestination(undefined, "_rumdata")).toEqual([
      DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT,
    ]);
  });
});

describe("classifyDrift", () => {
  it("reports NO_DRIFT overall when there is nothing to report", () => {
    expect(classifyDrift({})).toEqual({ overall: DRIFT_CLASS.NO_DRIFT, findings: [] });
  });

  it("picks SECURITY_DRIFT as the most severe overall class when present alongside others", () => {
    const result = classifyDrift({
      settingsDiffs: [{ field: "data_retention", desired: 7, actual: 30 }],
      schemaFindings: [{ validation: { ...CLEAN_VALIDATION, forbiddenPresent: ["password"] } }],
      pipelineFindings: [],
    });
    expect(result.overall).toBe(DRIFT_CLASS.SECURITY_DRIFT);
    expect(result.findings.length).toBe(2);
  });

  it("picks PIPELINE_DESTINATION_DRIFT over RETENTION_DRIFT/INDEX_DRIFT when no schema/security issue exists", () => {
    const result = classifyDrift({
      settingsDiffs: [{ field: "index_fields", desired: [], actual: ["message"] }],
      pipelineFindings: [DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT],
    });
    expect(result.overall).toBe(DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT);
  });

  it("picks SAFE_ADDITIVE_NATIVE_DRIFT only when nothing more severe is present", () => {
    const result = classifyDrift({
      schemaFindings: [{ validation: { ...CLEAN_VALIDATION, unknownAdditive: ["new_metric"] } }],
    });
    expect(result.overall).toBe(DRIFT_CLASS.SAFE_ADDITIVE_NATIVE_DRIFT);
  });
});
