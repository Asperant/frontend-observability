// Pure, read-only dashboard/panel/query risk auditor. No I/O, never mutates
// or deletes anything — scripts/lab/dashboards-audit.mjs is the only caller,
// and only ever reads dashboards to hand them to this module (roadmap: "Read-only
// dashboard audit ... bütün starter ve company-owned dashboardları
// değiştirmeden taramalı").
//
// Field-name/pattern lists below intentionally mirror
// infrastructure/openobserve/streams/{rumdata,rumlog}.schema-contract.json's
// own forbiddenFieldNames/forbiddenFieldNamePatterns/forbiddenValuePatterns —
// copied rather than imported so this module stays a pure function of its
// arguments (no filesystem/module-graph dependency on the streams catalog).
import { HIGH_CARDINALITY_FIELDS } from "./query-manifest.js";

export const RISK_CLASS = Object.freeze({
  PASS: "PASS",
  WARNING: "WARNING",
  PRIVACY_RISK: "PRIVACY_RISK",
  SECURITY_RISK: "SECURITY_RISK",
  QUERY_RISK: "QUERY_RISK",
  CARDINALITY_RISK: "CARDINALITY_RISK",
  UNSUPPORTED_FEATURE: "UNSUPPORTED_FEATURE",
});

const SEVERITY_ORDER = [
  RISK_CLASS.SECURITY_RISK,
  RISK_CLASS.PRIVACY_RISK,
  RISK_CLASS.QUERY_RISK,
  RISK_CLASS.CARDINALITY_RISK,
  RISK_CLASS.UNSUPPORTED_FEATURE,
  RISK_CLASS.WARNING,
  RISK_CLASS.PASS,
];

const FORBIDDEN_FIELD_NAMES = Object.freeze([
  "usr",
  "user",
  "account",
  "headers",
  "request",
  "response",
  "body",
  "payload",
  "request_body",
  "response_body",
  "graphql",
  "graphql_variables",
  "context",
  "http",
  "http_url",
]);

// Alnum-boundary (not \b) anchored: unlike a plain \b, this also treats `_`
// as a separator, so "auth_token" or "select auth_token from ..." both
// match — a plain `\b` would not, since `_` is itself a \w character and
// "auth_token" reads as one unbroken "word" to \b. This is the free-text-
// scanning analog of infrastructure/openobserve/streams/*.schema-contract.json's
// `(^|_)...($|_)`-anchored patterns (which match an isolated field NAME,
// where that anchoring is exactly right); here the match can appear
// anywhere inside a longer string.
function wordPattern(term) {
  return new RegExp(`(?<![a-z0-9])${term}(?![a-z0-9])`, "i");
}

const FORBIDDEN_FIELD_NAME_PATTERNS = Object.freeze([
  wordPattern("auth(orization)?"),
  wordPattern("cookie"),
  wordPattern("(token|bearer)"),
  wordPattern("secret"),
  wordPattern("private[_-]?key"),
  wordPattern("password"),
  wordPattern("(req|request|res|response)_body"),
  wordPattern("(email|user_email)"),
]);

const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  /(authorization|cookie|set-cookie|bearer\s+[a-z0-9._~+/=-]{16,}|api[_-]?key\s*[=:"]|secret\s*[=:"]|password\s*[=:"]|private key)/i,
]);

const REPLAY_PATTERNS = Object.freeze([/session\s*replay/i, /_rumreplay/i]);

const DELIVERY_GUARANTEE_PATTERNS = Object.freeze([
  /guarantee(d)?\s+(delivery|storage)/i,
  /always\s+(stored|delivered)/i,
  /never\s+lost/i,
  /purge(d)?\s+guarantee/i,
]);

const CUSTOM_JS_PANEL_TYPES = Object.freeze(["custom_chart", "customchart", "html", "javascript"]);

const AGGREGATE_FUNCTION_PATTERN =
  /\b(count|sum|avg|min|max|approx_percentile_cont|percentile_cont|histogram)\s*\(/i;

const MAX_TIME_RANGE_US = 168 * 60 * 60 * 1_000_000;

function isExactDrilldownQuery(sql) {
  return /\bsession_id\s*=|\bview_id\s*=|\bchicek_correlation_(session|view|epoch)_id\s*=/i.test(
    sql,
  );
}

// Forbidden-field-name/pattern/value checks apply to any text — a title or
// description accidentally naming a sensitive field is still worth
// flagging. The SQL-injection-marker, Session Replay, and
// guaranteed-delivery checks below are scoped to actual query SQL text only
// (see scanSqlText): a dashboard's own governance prose is expected to
// discuss "Session Replay" or use a semicolon in a sentence when explaining
// what is deliberately *not* included, and free text is not SQL that could
// ever be executed — flagging prose for either would be a false positive,
// not a real risk.
function scanForbiddenFieldSignals(text, findings, { panelId, source }) {
  if (typeof text !== "string" || text.length === 0) return;

  for (const name of FORBIDDEN_FIELD_NAMES) {
    const wordPattern = new RegExp(`\\b${name}\\b`, "i");
    if (wordPattern.test(text)) {
      findings.push({
        class: RISK_CLASS.PRIVACY_RISK,
        panelId,
        message: `${source} references forbidden field name '${name}'`,
      });
    }
  }
  for (const pattern of FORBIDDEN_FIELD_NAME_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({
        class: RISK_CLASS.SECURITY_RISK,
        panelId,
        message: `${source} matches a forbidden credential/secret-shaped field pattern (${pattern})`,
      });
    }
  }
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({
        class: RISK_CLASS.SECURITY_RISK,
        panelId,
        message: `${source} contains a raw credential/secret-shaped value`,
      });
    }
  }
}

function scanSqlText(sql, findings, { panelId, source }) {
  if (typeof sql !== "string" || sql.length === 0) return;
  scanForbiddenFieldSignals(sql, findings, { panelId, source });

  for (const pattern of REPLAY_PATTERNS) {
    if (pattern.test(sql)) {
      findings.push({
        class: RISK_CLASS.SECURITY_RISK,
        panelId,
        message: `${source} references Session Replay`,
      });
    }
  }
  for (const pattern of DELIVERY_GUARANTEE_PATTERNS) {
    if (pattern.test(sql)) {
      findings.push({
        class: RISK_CLASS.SECURITY_RISK,
        panelId,
        message: `${source} claims a guaranteed-delivery/storage/purge property`,
      });
    }
  }
  if (/;/.test(sql)) {
    findings.push({
      class: RISK_CLASS.SECURITY_RISK,
      panelId,
      message: `${source} contains a statement separator (;)`,
    });
  }
  if (/--|\/\*/.test(sql)) {
    findings.push({
      class: RISK_CLASS.SECURITY_RISK,
      panelId,
      message: `${source} contains a SQL comment marker`,
    });
  }
}

function auditQuery(panel, query, findings, queryResults) {
  const panelId = panel.id;
  const sql = query.query ?? "";
  scanSqlText(sql, findings, { panelId, source: `panel '${panelId}' query` });

  const drilldown = isExactDrilldownQuery(sql);

  if (/select\s+\*/i.test(sql) && !drilldown) {
    findings.push({
      class: RISK_CLASS.QUERY_RISK,
      panelId,
      message: "overview/table query uses SELECT * instead of an explicit field list",
    });
  }

  if (!drilldown) {
    const hasService = /\bservice\s*=|\$service\b/i.test(sql);
    const hasEnvironment = /\benv\s*=|\$environment\b|\$env\b/i.test(sql);
    if (!hasService || !hasEnvironment) {
      findings.push({
        class: RISK_CLASS.QUERY_RISK,
        panelId,
        message: "query is missing a required service/environment filter",
      });
    }
  }

  const groupByMatch = sql.match(/group by (.+?)(order by|limit|$)/i);
  if (groupByMatch) {
    const fields = groupByMatch[1].split(",").map((field) => field.trim().toLowerCase());
    for (const field of fields) {
      if (HIGH_CARDINALITY_FIELDS.includes(field)) {
        findings.push({
          class: RISK_CLASS.CARDINALITY_RISK,
          panelId,
          message: `GROUP BY uses the high-cardinality field '${field}'`,
        });
      }
    }
  }

  const hasAggregate = AGGREGATE_FUNCTION_PATTERN.test(sql);
  const hasLimit = /limit\s+\d+/i.test(sql);
  if (!hasAggregate && !hasLimit) {
    findings.push({
      class: RISK_CLASS.QUERY_RISK,
      panelId,
      message: "non-aggregate query has no row LIMIT",
    });
  }

  const timestampRange = sql.match(/_timestamp\s+between\s+(\d+)\s+and\s+(\d+)/i);
  if (timestampRange) {
    const span = Number(timestampRange[2]) - Number(timestampRange[1]);
    if (span > MAX_TIME_RANGE_US) {
      findings.push({
        class: RISK_CLASS.QUERY_RISK,
        panelId,
        message: "query's literal _timestamp range exceeds the 168h ceiling",
      });
    }
  }

  const executionResult = queryResults?.[panelId];
  if (executionResult && executionResult.status !== 200) {
    findings.push({
      class: RISK_CLASS.QUERY_RISK,
      panelId,
      message: `query execution failed (status ${executionResult.status}): ${executionResult.error ?? "unknown error"}`,
    });
  }
}

function auditPanel(panel, findings, queryResults) {
  scanForbiddenFieldSignals(panel.title, findings, {
    panelId: panel.id,
    source: `panel '${panel.id}' title`,
  });
  scanForbiddenFieldSignals(panel.description, findings, {
    panelId: panel.id,
    source: `panel '${panel.id}' description`,
  });

  if (CUSTOM_JS_PANEL_TYPES.includes(panel.type)) {
    findings.push({
      class: RISK_CLASS.UNSUPPORTED_FEATURE,
      panelId: panel.id,
      message: `panel type '${panel.type}' is a custom/JavaScript chart type, which this stage does not support`,
    });
  }

  for (const query of panel.queries ?? []) {
    auditQuery(panel, query, findings, queryResults);
  }
}

function highestSeverity(classes) {
  for (const candidate of SEVERITY_ORDER) {
    if (classes.includes(candidate)) return candidate;
  }
  return RISK_CLASS.PASS;
}

/**
 * Audits one already-fetched dashboard body (normalize.js's normalized
 * shape, or a raw v3 body — both have `title`/`description`/`tabs`) for the
 * risk categories the roadmap task requires. `queryResults` (optional) maps
 * panel id -> `{status, error}` for the caller's own live execution results
 * (this module never executes a query itself). Never mutates `dashboard`.
 */
export function auditDashboard(dashboard, { queryResults } = {}) {
  const findings = [];
  scanForbiddenFieldSignals(dashboard.title, findings, {
    panelId: null,
    source: "dashboard title",
  });
  scanForbiddenFieldSignals(dashboard.description, findings, {
    panelId: null,
    source: "dashboard description",
  });

  for (const tab of dashboard.tabs ?? []) {
    for (const panel of tab.panels ?? []) {
      auditPanel(panel, findings, queryResults);
    }
  }

  return { overall: highestSeverity(findings.map((finding) => finding.class)), findings };
}
