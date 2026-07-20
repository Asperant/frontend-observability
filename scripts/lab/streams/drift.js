// Pure drift classification, combining schema-contract.js's per-record
// validation output, manifest.js's settings diff output, and a pipeline
// destination check into the closed set of drift classes the Stage 15
// roadmap task defines. No I/O.

export const DRIFT_CLASS = Object.freeze({
  NO_DRIFT: "NO_DRIFT",
  SAFE_ADDITIVE_NATIVE_DRIFT: "SAFE_ADDITIVE_NATIVE_DRIFT",
  BREAKING_SCHEMA_DRIFT: "BREAKING_SCHEMA_DRIFT",
  SECURITY_DRIFT: "SECURITY_DRIFT",
  SETTINGS_DRIFT: "SETTINGS_DRIFT",
  RETENTION_DRIFT: "RETENTION_DRIFT",
  INDEX_DRIFT: "INDEX_DRIFT",
  PIPELINE_DESTINATION_DRIFT: "PIPELINE_DESTINATION_DRIFT",
});

// Highest severity first: this is the order classifyDrift() uses to pick a
// single `overall` result out of a set of individually-classified findings.
const SEVERITY_ORDER = [
  DRIFT_CLASS.SECURITY_DRIFT,
  DRIFT_CLASS.BREAKING_SCHEMA_DRIFT,
  DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT,
  DRIFT_CLASS.RETENTION_DRIFT,
  DRIFT_CLASS.INDEX_DRIFT,
  DRIFT_CLASS.SETTINGS_DRIFT,
  DRIFT_CLASS.SAFE_ADDITIVE_NATIVE_DRIFT,
  DRIFT_CLASS.NO_DRIFT,
];

const RETENTION_FIELDS = new Set(["data_retention", "max_query_range"]);
const INDEX_FIELDS = new Set([
  "full_text_search_keys",
  "index_fields",
  "bloom_filter_fields",
  "partition_keys",
  "distinct_value_fields",
]);

// A single legitimate new native metric per canary is expected; a burst of
// unrelated unknown fields signals an unbounded/unexpected schema change
// instead (roadmap: "bounded olmayan field-count artışı -> BREAKING").
export const MAX_SAFE_ADDITIVE_FIELDS_PER_CANARY = 10;

/**
 * Classifies a single settings-diff entry (see manifest.js's diffSettings)
 * into the drift class it represents. `store_original_data` flipping to a
 * truthy value is always SECURITY_DRIFT, regardless of desired direction,
 * because store_original_data:true is unsafe on a canonical stream even if
 * a manifest were (incorrectly) edited to desire it — see
 * docs/openobserve-v0.91-stream-capabilities.md capability #10.
 */
export function classifySettingsDiff(diff) {
  if (diff.field === "store_original_data" && diff.actual === true) {
    return DRIFT_CLASS.SECURITY_DRIFT;
  }
  if (RETENTION_FIELDS.has(diff.field)) return DRIFT_CLASS.RETENTION_DRIFT;
  if (INDEX_FIELDS.has(diff.field)) return DRIFT_CLASS.INDEX_DRIFT;
  return DRIFT_CLASS.SETTINGS_DRIFT;
}

/**
 * Classifies schema-contract.js's validateRecord() output (plus an
 * optional detectTypeChanges() result) for one canary record into the
 * drift classes it represents.
 */
export function classifySchemaFindings(validation, typeChanges = []) {
  const classes = [];
  if (
    validation.forbiddenPresent.length > 0 ||
    validation.forbiddenPatternMatches.length > 0 ||
    validation.urlLeaks.length > 0 ||
    validation.valuePatternMatches.length > 0
  ) {
    classes.push(DRIFT_CLASS.SECURITY_DRIFT);
  }
  if (
    validation.missingRequired.length > 0 ||
    validation.uncontrolledChicek.length > 0 ||
    typeChanges.length > 0 ||
    validation.unknownAdditive.length > MAX_SAFE_ADDITIVE_FIELDS_PER_CANARY
  ) {
    classes.push(DRIFT_CLASS.BREAKING_SCHEMA_DRIFT);
  }
  if (
    validation.unknownAdditive.length > 0 &&
    validation.unknownAdditive.length <= MAX_SAFE_ADDITIVE_FIELDS_PER_CANARY
  ) {
    classes.push(DRIFT_CLASS.SAFE_ADDITIVE_NATIVE_DRIFT);
  }
  return classes;
}

/**
 * Verifies a realtime pipeline's declared source/destination stream
 * (as returned by `GET /api/{org}/pipelines`, matching the shape
 * scripts/lab/provision-sanitization.mjs already produces/reads) still
 * targets the exact canonical stream it is supposed to.
 */
export function classifyPipelineDestination(pipeline, expectedStreamName) {
  const sourceOk = pipeline?.source?.stream_name === expectedStreamName;
  const destinationNode = (pipeline?.nodes ?? []).find(
    (node) => node?.data?.node_type === "stream" && node?.io_type === "output",
  );
  const destinationOk = destinationNode?.data?.stream_name === expectedStreamName;
  return sourceOk && destinationOk ? [] : [DRIFT_CLASS.PIPELINE_DESTINATION_DRIFT];
}

function highestSeverity(classes) {
  for (const candidate of SEVERITY_ORDER) {
    if (classes.includes(candidate)) return candidate;
  }
  return DRIFT_CLASS.NO_DRIFT;
}

/**
 * Combines every dimension of drift (settings diffs, schema findings across
 * one or more canary records, pipeline destination) into one report: the
 * single most severe class present (`overall`), plus the full list of
 * individual findings for reporting/logging.
 */
export function classifyDrift({ settingsDiffs = [], schemaFindings = [], pipelineFindings = [] }) {
  const findings = [];
  for (const diff of settingsDiffs) {
    findings.push({ class: classifySettingsDiff(diff), detail: diff });
  }
  for (const finding of schemaFindings) {
    for (const cls of classifySchemaFindings(finding.validation, finding.typeChanges)) {
      findings.push({ class: cls, detail: finding });
    }
  }
  for (const cls of pipelineFindings) {
    findings.push({ class: cls, detail: { pipelineDestinationDrift: true } });
  }
  return { overall: highestSeverity(findings.map((f) => f.class)), findings };
}
