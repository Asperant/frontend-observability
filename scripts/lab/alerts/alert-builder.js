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
  if (policy.id === "telemetry-freshness") return "freshness_seconds";
  return policy.metricId;
}

function sampleGuard(policy) {
  if (policy.id === "telemetry-freshness") return "freshness_seconds is not null";
  return `${policy.sample.field} >= ${policy.sample.minimum}`;
}

// telemetry-freshness's threshold.starterValue is deliberately left as the
// literal string "REQUIRED_COMPANY_DECISION_MAXIMUM_SILENCE_MINUTES" (unlike
// every other alert here, which has a real numeric starterValue) — how long
// a silence is acceptable depends entirely on a given company's expected
// traffic pattern (see requiredScope/expectedTrafficHours, also
// REQUIRED_COMPANY_DECISION), so this reference project intentionally does
// not invent one. Interpolating that placeholder string directly into SQL
// would be a syntax error, so thresholdGuard() hardcodes "false" instead —
// the query, sample guard, and dashboard panel it shares are still fully
// real and correct (see last-observed-ingestion-age-rumdata.query.json), so
// only the trigger condition itself is a stub. A real deployment must
// replace threshold.starterValue with an actual number of minutes before
// this alert can ever fire; until then it installs cleanly and evaluates on
// schedule without error, but never breaches.
function thresholdGuard(policy) {
  if (policy.id === "telemetry-freshness") return "false";
  return `${metricColumn(policy)} > ${policy.threshold.starterValue}`;
}

function buildCandidateSql(policy, queryManifest, scope) {
  const sourceSql = renderStage16Sql(queryManifest, scope);
  return `select ${metricColumn(policy)} as zo_sql_val from (${sourceSql}) where ${sampleGuard(policy)} and ${thresholdGuard(policy)} limit 1`;
}

function renderDedupKey(policy, scope) {
  return policy.deduplicationKey
    .replaceAll("{service}", scope.service)
    .replaceAll("{environment}", scope.environment);
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
    dedup_key: renderDedupKey(policy, scope),
    minimum_sample: String(policy.sample.minimum ?? policy.sample.minimumCurrent),
    required_consecutive_breaches: String(policy.breach.requiredConsecutiveBreaches),
    recovery_condition: JSON.stringify(policy.recoveryCondition),
    no_data_policy: policy.noDataPolicy,
    query_error_policy: policy.queryErrorPolicy,
  };
}

// This pinned OpenObserve build's HTTP destination templates only ever
// substitute a fixed built-in token set for scheduled SQL alerts —
// {org_name, stream_type, stream_name, alert_name, alert_type, alert_period,
// alert_operator, alert_threshold, alert_count, alert_agg_value,
// alert_start_time, alert_end_time, alert_url, alert_trigger_time(+_millis/
// _seconds/_str), alert_description} — confirmed by extracting the pinned
// binary's own embedded UI help-text strings, not guessed. There is no
// `{alert_context_attributes.<key>}`/`{alert_status}` substitution: those
// tokens were this repo's own earlier (unverified) assumption, and a real
// live fire proved they render as literal, un-substituted text — see
// docs/openobserve-v0.91-alert-capabilities.md capability #16. `threshold`/
// `operator` also can't come from OpenObserve's own {alert_threshold}/
// {alert_operator} tokens: those reflect the fixed row-count trigger
// (always ">= 1" here), not this policy's real business threshold, which
// lives inside the SQL's own WHERE clause. `context_attributes` is still
// sent (real, accepted field — visible in OpenObserve's own alert detail
// UI) but is deliberately not relied on for notification-body rendering;
// this line folds the same values into `description`, which does have a
// real, verified token (`{alert_description}`).
function notificationMetadataLine(attributes) {
  return [
    `severity=${attributes.severity}`,
    `service=${attributes.service}`,
    `environment=${attributes.environment}`,
    `version=${attributes.version}`,
    `threshold=${attributes.threshold}`,
    `sampleSize=${attributes.sample_size}`,
    `evaluationWindow=${attributes.evaluation_window}`,
    `dashboardRef=${attributes.dashboard_ref}`,
    `runbookRef=${attributes.runbook_ref}`,
    `dedupKey=${attributes.dedup_key}`,
  ].join(" ");
}

export function buildOpenObserveAlert(
  policy,
  queryManifest,
  { owner, scope, destinationName, templateName },
) {
  const now = new Date().toISOString();
  const attributes = contextAttributes(policy, scope);
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
    context_attributes: attributes,
    enabled: false,
    // Single line, deliberately: OpenObserve's {alert_description} token
    // substitution does not JSON-escape the value it inserts, so a raw
    // newline here would break the notification body's JSON syntax for any
    // destination whose template embeds it in a JSON string — verified
    // live (a `\n`-bearing description produced a body alert-sink's own
    // JSON.parse rejected outright, silently dropping every field). See
    // docs/openobserve-v0.91-alert-capabilities.md capability #16.
    description: `${policy.description} | ${notificationMetadataLine(attributes)} | ${buildMarker({ starterId: policy.id, starterVersion: policy.schemaVersion })}`,
    row_template: "",
    row_template_type: "String",
    last_triggered_at: 0,
    // last_triggered_at is deliberately never set here — it is OpenObserve's
    // own server-managed record of when this alert's condition genuinely
    // last evaluated true, exactly like the field normalizeAlertExport()
    // (policy.js) strips before any declarative comparison. Stamping
    // Date.now() here (as this line previously did) made every freshly
    // installed/restored alert falsely claim to have "Last Triggered" right
    // then, in the Alerts list, even for alerts that had never evaluated —
    // or, for telemetry-freshness/version-regression (thresholdGuard()
    // hardcodes their condition to "false"), that can never genuinely
    // trigger at all.
    createdAt: now,
    updatedAt: now,
    owner,
    lastEditedBy: owner,
    folder_id: "default",
    creates_incident: false,
  };
}
