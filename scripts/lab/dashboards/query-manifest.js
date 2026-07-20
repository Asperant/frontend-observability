// Pure shape + SQL-safety validation for one
// infrastructure/openobserve/analytics/queries/*.query.json manifest. No
// I/O, no network, no execution of the SQL itself (see
// scripts/lab/dashboards-verify equivalents / verify-stage16-dashboards.mjs
// for live execution against the real API) — this module only ever inspects
// the manifest object and its sqlTemplate text.

export const QUERY_CLASS = Object.freeze({
  OVERVIEW: "OVERVIEW",
  TABLE: "TABLE",
  LIST: "LIST",
  DRILLDOWN: "DRILLDOWN",
});

export const CARDINALITY_CLASS = Object.freeze({
  LOW_CARDINALITY_OVERVIEW: "LOW_CARDINALITY_OVERVIEW",
  BOUNDED_TABLE: "BOUNDED_TABLE",
  BOUNDED_LIST: "BOUNDED_LIST",
  BOUNDED_DRILLDOWN: "BOUNDED_DRILLDOWN",
});

export const MAX_TIME_RANGE_CEILING_HOURS = 168;

// Mirrors infrastructure/openobserve/streams/{rumdata,rumlog}.schema-contract.json's
// own classification of which fields are only ever safe as an exact-match
// drill-down input, never an overview/table group-by dimension.
export const HIGH_CARDINALITY_FIELDS = Object.freeze([
  "session_id",
  "view_id",
  "action_id",
  "resource_id",
  "error_id",
  "long_task_id",
  "resource_url",
  "view_url",
  "error_message",
  "error_stack",
  "_timestamp",
  "ip",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function collectPlaceholderTokens(sqlTemplate) {
  const matches = sqlTemplate.match(/\{\{[^}]*\}\}/g) ?? [];
  return matches;
}

function extractGroupByFields(sqlTemplate) {
  const match = sqlTemplate.match(/group by (.+?)(order by|limit|$)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter((field) => field.length > 0);
}

/**
 * Validates one query manifest's shape and SQL-authoring-time safety rules.
 * Returns { valid, errors: string[] } — never throws, so a caller can
 * validate an entire catalog and report every problem at once.
 */
export function validateQueryManifest(manifest) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!isNonEmptyString(manifest?.id)) fail("id must be a non-empty string");
  if (!Number.isInteger(manifest?.version) || manifest.version < 1) {
    fail("version must be a positive integer");
  }
  if (manifest?.metricId !== null && !isNonEmptyString(manifest?.metricId)) {
    fail("metricId must be null or a non-empty string");
  }
  if (!isNonEmptyString(manifest?.title)) fail("title must be a non-empty string");
  if (!Object.values(QUERY_CLASS).includes(manifest?.queryClass)) {
    fail(`queryClass must be one of ${Object.values(QUERY_CLASS).join(", ")}`);
  }
  if (!isNonEmptyString(manifest?.stream)) fail("stream must be a non-empty string");
  if (!isNonEmptyString(manifest?.sqlTemplate)) fail("sqlTemplate must be a non-empty string");
  if (!isStringArray(manifest?.requiredVariables)) fail("requiredVariables must be a string array");
  if (!Array.isArray(manifest?.optionalVariables)) fail("optionalVariables must be an array");
  if (!isStringArray(manifest?.drilldownVariables))
    fail("drilldownVariables must be a string array");
  if (
    !Number.isInteger(manifest?.timeRangeCeilingHours) ||
    manifest.timeRangeCeilingHours < 1 ||
    manifest.timeRangeCeilingHours > MAX_TIME_RANGE_CEILING_HOURS
  ) {
    fail(`timeRangeCeilingHours must be an integer between 1 and ${MAX_TIME_RANGE_CEILING_HOURS}`);
  }
  if (
    manifest?.rowLimit !== null &&
    (!Number.isInteger(manifest?.rowLimit) || manifest.rowLimit < 1)
  ) {
    fail("rowLimit must be null or a positive integer");
  }
  if (!Number.isInteger(manifest?.timeoutBudgetMs) || manifest.timeoutBudgetMs < 1) {
    fail("timeoutBudgetMs must be a positive integer");
  }
  if (!Array.isArray(manifest?.expectedColumns)) fail("expectedColumns must be an array");
  if (!isNonEmptyString(manifest?.emptyDataSemantics)) {
    fail("emptyDataSemantics must be a non-empty string");
  }
  if (!Object.values(CARDINALITY_CLASS).includes(manifest?.cardinalityClass)) {
    fail(`cardinalityClass must be one of ${Object.values(CARDINALITY_CLASS).join(", ")}`);
  }
  if (typeof manifest?.hasDivisionGuard !== "boolean") fail("hasDivisionGuard must be a boolean");

  // From here on, only run SQL-text checks if the shape is sound enough for
  // them to be meaningful (a missing/non-string sqlTemplate already failed
  // above and would make every regex check below throw).
  if (
    !isNonEmptyString(manifest?.sqlTemplate) ||
    !Object.values(QUERY_CLASS).includes(manifest?.queryClass)
  ) {
    return { valid: errors.length === 0, errors };
  }

  const sql = manifest.sqlTemplate;
  const sqlLower = sql.toLowerCase();
  const selectStar = /select\s+\*/i.test(sql);
  const isDrilldown = manifest.queryClass === QUERY_CLASS.DRILLDOWN;
  // Sanitized local copies: the shape checks above already recorded an error
  // for a non-array requiredVariables/drilldownVariables/optionalVariables,
  // but execution continues into these SQL-text checks regardless (so every
  // problem is reported at once) — falling back to `[]` here (rather than
  // `manifest.x ?? []`, which only catches null/undefined, not e.g. a
  // string) keeps that continuation crash-free.
  const requiredVariables = Array.isArray(manifest.requiredVariables)
    ? manifest.requiredVariables
    : [];
  const drilldownVariables = Array.isArray(manifest.drilldownVariables)
    ? manifest.drilldownVariables
    : [];
  const optionalVariables = Array.isArray(manifest.optionalVariables)
    ? manifest.optionalVariables
    : [];

  if (selectStar && !isDrilldown) {
    fail("overview/table queries must use an explicit field list, not SELECT *");
  }
  if (!isDrilldown) {
    if (!requiredVariables.includes("service")) {
      fail("overview/table queries must require the 'service' variable");
    }
    if (!requiredVariables.includes("environment")) {
      fail("overview/table queries must require the 'environment' variable");
    }
    if (drilldownVariables.length > 0) {
      fail("overview/table queries must not declare drilldownVariables");
    }
  } else {
    if (requiredVariables.length > 0) {
      fail("drilldown queries must not declare requiredVariables (service/environment)");
    }
    if (drilldownVariables.length === 0) {
      fail("drilldown queries must declare at least one drilldownVariable");
    }
  }

  if (manifest.queryClass === QUERY_CLASS.TABLE) {
    if (manifest.rowLimit === null) fail("table queries must declare a positive rowLimit");
    if (!/group by/i.test(sql)) fail("table queries must use GROUP BY");
    if (!/order by/i.test(sql)) fail("table queries must use ORDER BY for deterministic ordering");
    if (!/limit\s+\d+/i.test(sql)) fail("table queries must use an explicit LIMIT");
  }
  if (manifest.queryClass === QUERY_CLASS.LIST) {
    if (manifest.rowLimit === null) fail("list queries must declare a positive rowLimit");
    if (!/order by/i.test(sql)) fail("list queries must use ORDER BY for deterministic ordering");
    if (!/limit\s+\d+/i.test(sql)) fail("list queries must use an explicit LIMIT");
  }
  if (manifest.queryClass === QUERY_CLASS.OVERVIEW && manifest.rowLimit !== null) {
    fail("overview queries must not declare a rowLimit (single-row aggregate)");
  }
  if (isDrilldown && manifest.rowLimit !== null) {
    if (!/order by/i.test(sql))
      fail("list-style drilldown queries must use ORDER BY for deterministic ordering");
    if (!/limit\s+\d+/i.test(sql)) fail("list-style drilldown queries must use an explicit LIMIT");
  }

  if (manifest.hasDivisionGuard) {
    if (!/case\s+when/i.test(sql) || !sqlLower.includes("null")) {
      fail("hasDivisionGuard:true queries must guard the division with a CASE ... NULL pattern");
    }
  }

  const groupByFields = extractGroupByFields(sql);
  for (const field of groupByFields) {
    if (HIGH_CARDINALITY_FIELDS.includes(field)) {
      fail(
        `GROUP BY must not use the high-cardinality field '${field}' in an overview/table query`,
      );
    }
  }

  const allowedPlaceholders = new Set([
    ...requiredVariables.map((name) => `{{${name}}}`),
    ...drilldownVariables.map((name) => `{{${name}}}`),
    ...optionalVariables.map((entry) => entry.clausePlaceholder),
  ]);
  for (const token of collectPlaceholderTokens(sql)) {
    if (!allowedPlaceholders.has(token)) {
      fail(`sqlTemplate contains an unrecognized placeholder token: ${token}`);
    }
  }

  if (/;/.test(sql)) fail("sqlTemplate must not contain a statement separator (;)");
  if (/--|\/\*/.test(sql)) fail("sqlTemplate must not contain a SQL comment marker");

  return { valid: errors.length === 0, errors };
}
