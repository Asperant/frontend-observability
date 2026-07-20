import { buildMarker } from "./marker.js";

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function renderStage16Sql(queryManifest, { service, environment, version = null }) {
  let sql = queryManifest.sqlTemplate
    .replaceAll("{{service}}", quote(service))
    .replaceAll("{{environment}}", quote(environment));
  const versionClause = version === null ? "" : ` and version = ${quote(version)}`;
  sql = sql.replaceAll("{{version_clause}}", versionClause);
  return sql;
}

function metricColumn(policy) {
  if (policy.id === "web-vital-degradation") return "p75";
  if (policy.id === "telemetry-freshness") return "last_event_us";
  if (policy.id === "version-regression") return "version_regression_candidate";
  return policy.metricId;
}

function sampleGuard(policy) {
  if (policy.id === "version-regression")
    return "current_sessions >= 30 and baseline_sessions >= 30";
  if (policy.id === "telemetry-freshness") return "last_event_us is not null";
  return `${policy.sample.field} >= ${policy.sample.minimum}`;
}

function thresholdGuard(policy) {
  if (policy.id === "telemetry-freshness") return "false";
  if (policy.id === "version-regression") return "false";
  return `${metricColumn(policy)} > ${policy.threshold.starterValue}`;
}

function buildCandidateSql(policy, queryManifest, scope) {
  const sourceSql = renderStage16Sql(queryManifest, scope);
  return `select ${metricColumn(policy)} as zo_sql_val from (${sourceSql}) where ${sampleGuard(policy)} and ${thresholdGuard(policy)} limit 1`;
}

function contextAttributes(policy, scope) {
  return {
    severity: policy.severity,
    service: scope.service,
    environment: scope.environment,
    version: scope.version ?? "bounded-by-alert-query",
    measured_value: metricColumn(policy),
    threshold: String(policy.threshold.starterValue ?? "REQUIRED_COMPANY_DECISION"),
    sample_size: `${policy.sample.field ?? "current/baseline"} >= ${policy.sample.minimum ?? policy.sample.minimumCurrent}`,
    evaluation_window: `${policy.evaluation.lookbackMinutes}m`,
    dashboard_ref: policy.dashboardRef,
    runbook_ref: policy.runbookRef,
    dedup_key: policy.deduplicationKey,
    minimum_sample: String(policy.sample.minimum ?? policy.sample.minimumCurrent),
    required_consecutive_breaches: String(policy.breach.requiredConsecutiveBreaches),
    recovery_condition: JSON.stringify(policy.recoveryCondition),
    no_data_policy: policy.noDataPolicy,
    query_error_policy: policy.queryErrorPolicy,
  };
}

export function buildOpenObserveAlert(
  policy,
  queryManifest,
  { owner, scope, destinationName, templateName },
) {
  const now = new Date().toISOString();
  return {
    name: policy.id,
    stream_type: "logs",
    stream_name: policy.stream,
    is_real_time: false,
    query_condition: {
      type: "sql",
      conditions: [],
      sql: buildCandidateSql(policy, queryManifest, scope),
      promql: "",
      promql_condition: null,
      vrl_function: null,
      multi_time_range: [],
      aggregation: null,
    },
    trigger_condition: {
      period: policy.evaluation.lookbackMinutes,
      operator: ">=",
      frequency: policy.evaluation.intervalMinutes,
      cron: "",
      threshold: 1,
      silence: policy.cooldown.minutes,
      frequency_type: "minutes",
      timezone: "UTC",
      tolerance_in_secs: null,
    },
    destinations: [destinationName],
    template: templateName,
    context_attributes: contextAttributes(policy, scope),
    enabled: false,
    description: `${policy.description}\n\n${buildMarker({ starterId: policy.id, starterVersion: policy.schemaVersion })}`,
    row_template: "",
    row_template_type: "String",
    lastTriggeredAt: Date.now(),
    createdAt: now,
    updatedAt: now,
    owner,
    lastEditedBy: owner,
    folder_id: "default",
    creates_incident: false,
  };
}
