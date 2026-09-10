// Pure validation of a single flattened OpenObserve record (a `_search`
// hit — plain object of fieldName -> scalar value) against a
// schema-contract document (infrastructure/openobserve/streams/*.schema-contract.json).
// No I/O, no network: this is deliberately reusable both by the live
// Chromium/Firefox canary (scripts/lab/verify-streams.mjs) and by
// unit tests with hand-built fixtures.

const FRONTEND_OBSERVABILITY_UNCONTROLLED_PATTERN = /^_?frontend_observability[_.]/i;

// The manifests/observability-contracts share a `(?i)case-insensitive` prefix convention
// with this repo's VRL sources (infrastructure/openobserve/sanitization/
// *.vrl) for readability, but JS RegExp has no inline `(?i)` group — every
// pattern here is case-insensitive by convention, so the prefix (if
// present) is stripped and the "i" flag is always applied instead.
function compilePattern(source) {
  return new RegExp(source.replace(/^\(\?i\)/, ""), "i");
}

function allConditionalFields(contract) {
  return Object.values(contract.conditionalNativeFieldGroups ?? {}).flat();
}

function compileFieldNamePatterns(contract) {
  return (contract.forbiddenFieldNamePatterns ?? []).map(compilePattern);
}

function compileValuePatterns(contract) {
  return (contract.forbiddenValuePatterns ?? []).map(compilePattern);
}

/**
 * Classifies every field present in `record` against the contract, and
 * separately reports which of `contract.requiredNativeFields` are missing.
 * Never throws on unexpected input shapes — a malformed/empty record is
 * just reported as "everything required is missing", which is itself a
 * meaningful, non-crashing finding for a caller to act on.
 */
export function validateRecord(contract, record) {
  const safeRecord = record && typeof record === "object" ? record : {};
  const recordFields = Object.keys(safeRecord);
  const required = new Set(contract.requiredNativeFields ?? []);
  const conditional = new Set(allConditionalFields(contract));
  const controlled = new Set(contract.controlledFields ?? []);
  const forbiddenNames = new Set(contract.forbiddenFieldNames ?? []);
  const namePatterns = compileFieldNamePatterns(contract);
  const valuePatterns = compileValuePatterns(contract);
  const urlFields = new Set(contract.urlFieldsMustNotContainQueryOrFragment ?? []);

  const missingRequired = [...required].filter((field) => !recordFields.includes(field));
  const forbiddenPresent = [];
  const forbiddenPatternMatches = [];
  const uncontrolledFrontendObservability = [];
  const unknownAdditive = [];
  const urlLeaks = [];
  const valuePatternMatches = [];

  for (const field of recordFields) {
    const value = safeRecord[field];

    if (forbiddenNames.has(field)) {
      forbiddenPresent.push(field);
    } else if (namePatterns.some((pattern) => pattern.test(field))) {
      forbiddenPatternMatches.push(field);
    } else if (FRONTEND_OBSERVABILITY_UNCONTROLLED_PATTERN.test(field) && !controlled.has(field)) {
      uncontrolledFrontendObservability.push(field);
    } else if (!required.has(field) && !conditional.has(field) && !controlled.has(field)) {
      unknownAdditive.push(field);
    }

    if (typeof value === "string") {
      if (valuePatterns.some((pattern) => pattern.test(value))) {
        valuePatternMatches.push(field);
      }
      if (urlFields.has(field) && /[?#]/.test(value)) {
        urlLeaks.push(field);
      }
    }
  }

  return {
    missingRequired,
    forbiddenPresent,
    forbiddenPatternMatches,
    uncontrolledFrontendObservability,
    unknownAdditive,
    urlLeaks,
    valuePatternMatches,
  };
}

export function isRecordClean(validation) {
  return (
    validation.missingRequired.length === 0 &&
    validation.forbiddenPresent.length === 0 &&
    validation.forbiddenPatternMatches.length === 0 &&
    validation.uncontrolledFrontendObservability.length === 0 &&
    validation.urlLeaks.length === 0 &&
    validation.valuePatternMatches.length === 0
  );
}

/**
 * Compares a live stream schema (`[{name, type}]`, as returned by
 * `GET /api/{org}/streams/{stream}/schema?type=logs`) against the
 * contract's `knownFieldTypes` map, reporting any field whose real type no
 * longer matches what was verified when the contract was written. A field
 * present in the live schema but absent from knownFieldTypes is not a type
 * change (it's new — handled by validateRecord's unknownAdditive/
 * uncontrolledFrontendObservability instead, which need an actual record, not just a
 * schema listing, to classify correctly).
 */
export function detectTypeChanges(contract, liveSchema) {
  const known = contract.knownFieldTypes ?? {};
  const changes = [];
  for (const entry of liveSchema ?? []) {
    const expected = known[entry.name];
    if (expected !== undefined && expected !== entry.type) {
      changes.push({ field: entry.name, expectedType: expected, actualType: entry.type });
    }
  }
  return changes;
}
