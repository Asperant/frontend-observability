// Pure shape validation for infrastructure/openobserve/analytics/metric-catalog.json,
// plus cross-referencing each metric's queryId against the query catalog's
// own ids. No I/O — the catalog object and the set of known query ids are
// both passed in by the caller (scripts/lab/dashboards/catalog.mjs loads
// them from disk).

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const REQUIRED_ALERT_READY_FIELDS = Object.freeze([
  "alertReady",
  "measurement",
  "windowPlaceholder",
  "minimumSampleSize",
  "thresholdDirection",
  "recoveryConditionPlaceholder",
  "grouping",
  "ownerPlaceholder",
  "runbookPlaceholder",
]);

function validateAlertReady(alertReady, errors, metricId) {
  if (typeof alertReady !== "object" || alertReady === null) {
    errors.push(`metric '${metricId}': alertReady must be an object`);
    return;
  }
  for (const field of REQUIRED_ALERT_READY_FIELDS) {
    if (!(field in alertReady)) {
      errors.push(`metric '${metricId}': alertReady.${field} is required`);
    }
  }
  if (typeof alertReady.alertReady !== "boolean") {
    errors.push(`metric '${metricId}': alertReady.alertReady must be a boolean`);
  }
  if (!isStringArray(alertReady.grouping)) {
    errors.push(`metric '${metricId}': alertReady.grouping must be a string array`);
  }
  if (
    alertReady.minimumSampleSize !== null &&
    !(Number.isInteger(alertReady.minimumSampleSize) && alertReady.minimumSampleSize >= 0)
  ) {
    errors.push(
      `metric '${metricId}': alertReady.minimumSampleSize must be null or a non-negative integer`,
    );
  }
}

function validateMetric(metric, errors) {
  const id = isNonEmptyString(metric?.id) ? metric.id : "<missing id>";
  if (!isNonEmptyString(metric?.id)) errors.push("metric entry missing a non-empty id");
  if (!isNonEmptyString(metric?.queryId))
    errors.push(`metric '${id}': queryId must be a non-empty string`);
  if (!isNonEmptyString(metric?.displayName))
    errors.push(`metric '${id}': displayName is required`);
  if (!isNonEmptyString(metric?.description))
    errors.push(`metric '${id}': description is required`);
  if (!isNonEmptyString(metric?.stream)) errors.push(`metric '${id}': stream is required`);
  if (!isNonEmptyString(metric?.eventScope)) errors.push(`metric '${id}': eventScope is required`);
  if (!isNonEmptyString(metric?.numerator)) errors.push(`metric '${id}': numerator is required`);
  if (metric?.denominator !== null && !isNonEmptyString(metric?.denominator)) {
    errors.push(`metric '${id}': denominator must be null or a non-empty string`);
  }
  if (!isNonEmptyString(metric?.unit)) errors.push(`metric '${id}': unit is required`);
  if (!isNonEmptyString(metric?.aggregation))
    errors.push(`metric '${id}': aggregation is required`);
  if (!isStringArray(metric?.requiredFilters) || metric.requiredFilters.length === 0) {
    errors.push(`metric '${id}': requiredFilters must be a non-empty string array`);
  } else if (
    !metric.requiredFilters.includes("service") ||
    !metric.requiredFilters.includes("environment")
  ) {
    errors.push(`metric '${id}': requiredFilters must include both 'service' and 'environment'`);
  }
  if (!isNonEmptyString(metric?.emptyDataSemantics)) {
    errors.push(`metric '${id}': emptyDataSemantics is required`);
  }
  if (
    !Number.isInteger(metric?.timeRangeCeilingHours) ||
    metric.timeRangeCeilingHours < 1 ||
    metric.timeRangeCeilingHours > 168
  ) {
    errors.push(`metric '${id}': timeRangeCeilingHours must be an integer between 1 and 168`);
  }
  if (!isNonEmptyString(metric?.cardinalityRisk))
    errors.push(`metric '${id}': cardinalityRisk is required`);
  if (!isStringArray(metric?.schemaDependencies) || metric.schemaDependencies.length === 0) {
    errors.push(`metric '${id}': schemaDependencies must be a non-empty string array`);
  }
  validateAlertReady(metric?.alertReady, errors, id);
}

/**
 * Validates the whole metric catalog document's shape, uniqueness of ids,
 * and that every metric's queryId resolves to a real query manifest id
 * (`knownQueryIds`, supplied by the caller after loading the query catalog).
 */
export function validateMetricCatalog(catalog, knownQueryIds) {
  const errors = [];
  if (!Array.isArray(catalog?.metrics) || catalog.metrics.length === 0) {
    return { valid: false, errors: ["catalog.metrics must be a non-empty array"] };
  }

  const seenIds = new Set();
  for (const metric of catalog.metrics) {
    validateMetric(metric, errors);
    if (isNonEmptyString(metric?.id)) {
      if (seenIds.has(metric.id)) errors.push(`duplicate metric id: ${metric.id}`);
      seenIds.add(metric.id);
    }
    if (isNonEmptyString(metric?.queryId) && !knownQueryIds.has(metric.queryId)) {
      errors.push(
        `metric '${metric.id}': queryId '${metric.queryId}' does not match any query manifest`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
