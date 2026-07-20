export const RISK_CLASS = Object.freeze({
  PASS: "PASS",
  WARNING: "WARNING",
  NOISE_RISK: "NOISE_RISK",
  QUERY_RISK: "QUERY_RISK",
  PRIVACY_RISK: "PRIVACY_RISK",
  SECURITY_RISK: "SECURITY_RISK",
  ROUTING_RISK: "ROUTING_RISK",
  UNSUPPORTED_FEATURE: "UNSUPPORTED_FEATURE",
});

const SENSITIVE_OUTPUT =
  /(token|cookie|authorization|password|secret|session_id|request_body|response_body|url|fragment|identity|rows)/i;
const SENSITIVE_SQL_FIELD =
  /\b(token|cookie|authorization|password|secret|session_id|request_body|response_body|url|fragment|identity)\b/i;
const REPLAY_OR_DELIVERY =
  /(session.?replay|guaranteed.?delivery|always.?delivered|no event loss|stored|purged)/i;
const HIGH_CARDINALITY_GROUP = /(group by[^;]*(session_id|view_id|user|url|trace_id|span_id))/i;

function push(findings, klass, message) {
  findings.push({ class: klass, message });
}

function hasRawSensitiveSqlProjection(sql) {
  const selectClause = sql?.match(/select\s+([\s\S]*?)\s+from/i)?.[1] ?? "";
  const aggregateSafeClause = selectClause.replace(
    /\b(?:count|count_distinct|approx_count_distinct|uniq)\s*\([^)]*\bsession_id\b[^)]*\)/gi,
    "aggregate_session_count",
  );
  return SENSITIVE_SQL_FIELD.test(aggregateSafeClause);
}

export function auditAlertDefinition(alert) {
  const findings = [];
  const trigger = alert.trigger_condition ?? {};
  const query = alert.query_condition ?? {};
  const text = JSON.stringify(alert);
  const notificationText = JSON.stringify({
    description: alert.description,
    row_template: alert.row_template,
    context_attributes: alert.context_attributes,
    template: alert.template,
  });

  if (!alert.owner || /REQUIRED|placeholder/i.test(alert.owner)) {
    push(findings, RISK_CLASS.ROUTING_RISK, "owner is missing or a placeholder");
  }
  if (!alert.destinations || alert.destinations.length === 0) {
    push(findings, RISK_CLASS.ROUTING_RISK, "destination is missing");
  }
  if (!alert.context_attributes?.runbook_ref) {
    push(findings, RISK_CLASS.ROUTING_RISK, "runbook reference is missing");
  }
  if (!trigger.period || trigger.period > 168 * 60) {
    push(findings, RISK_CLASS.QUERY_RISK, "lookback period is missing or too wide");
  }
  if (!trigger.frequency || trigger.frequency < 1) {
    push(findings, RISK_CLASS.NOISE_RISK, "evaluation frequency is missing or too short");
  }
  if (trigger.silence === undefined || trigger.silence < 1) {
    push(findings, RISK_CLASS.NOISE_RISK, "cooldown/silence is missing");
  }
  if (!alert.context_attributes?.minimum_sample) {
    push(findings, RISK_CLASS.NOISE_RISK, "minimum sample metadata is missing");
  }
  if (!alert.context_attributes?.required_consecutive_breaches) {
    push(findings, RISK_CLASS.NOISE_RISK, "consecutive breach metadata is missing");
  }
  if (!alert.context_attributes?.dedup_key) {
    push(findings, RISK_CLASS.NOISE_RISK, "dedup key metadata is missing");
  }
  if (!alert.context_attributes?.recovery_condition) {
    push(findings, RISK_CLASS.NOISE_RISK, "recovery metadata is missing");
  }
  if (!/service\s*=|service =|service:|service/.test(query.sql ?? "")) {
    push(findings, RISK_CLASS.QUERY_RISK, "service filter is missing");
  }
  if (!/env\s*=|environment|env =/.test(query.sql ?? "")) {
    push(findings, RISK_CLASS.QUERY_RISK, "environment filter is missing");
  }
  if (/select\s+\*/i.test(query.sql ?? "")) {
    push(findings, RISK_CLASS.QUERY_RISK, "query uses SELECT *");
  }
  if (HIGH_CARDINALITY_GROUP.test(query.sql ?? "")) {
    push(findings, RISK_CLASS.QUERY_RISK, "query groups by high-cardinality fields");
  }
  if (/(\{\{|;|--|\/\*)/.test(query.sql ?? "")) {
    push(findings, RISK_CLASS.SECURITY_RISK, "query has unsafe interpolation or SQL markers");
  }
  if (SENSITIVE_OUTPUT.test(notificationText) || hasRawSensitiveSqlProjection(query.sql)) {
    push(findings, RISK_CLASS.PRIVACY_RISK, "sensitive/raw field appears in alert");
  }
  if (REPLAY_OR_DELIVERY.test(text)) {
    push(
      findings,
      RISK_CLASS.UNSUPPORTED_FEATURE,
      "unsupported replay/delivery guarantee signal appears",
    );
  }
  if (alert.enabled && /REQUIRED_COMPANY_DECISION/.test(text)) {
    push(findings, RISK_CLASS.WARNING, "production enabled with placeholder decision metadata");
  }
  if (/custom.?code|javascript|action_script/i.test(text)) {
    push(findings, RISK_CLASS.SECURITY_RISK, "custom notification code is not allowed");
  }

  return {
    class: findings[0]?.class ?? RISK_CLASS.PASS,
    findings,
  };
}
