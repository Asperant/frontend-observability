// Pure, safe SQL-template renderer for infrastructure/openobserve/analytics/
// queries/*.query.json. No I/O. Never concatenates raw caller-supplied text
// into SQL: every value is validated against a fixed safe charset and
// single-quote-escaped before substitution (mirroring
// scripts/lab/verify-stage15-streams.mjs's own escapeSqlLiteral), and only a
// fixed, closed set of placeholder tokens is ever recognized — an unresolved
// or unrecognized `{{...}}` token is always a hard error, never silently
// left in the SQL text or passed through as-is.

export const TEMPLATE_ERROR_REASON = Object.freeze({
  MISSING_REQUIRED_VARIABLE: "MISSING_REQUIRED_VARIABLE",
  UNSAFE_VALUE: "UNSAFE_VALUE",
  UNRESOLVED_PLACEHOLDER: "UNRESOLVED_PLACEHOLDER",
});

export class TemplateError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = "TemplateError";
    this.reason = reason;
    this.detail = detail;
  }
}

// Matches the real values these fields ever legitimately hold on this
// pinned schema: service/env/version identifiers (dot/dash-separated),
// browser-family strings (may contain spaces), and UUID-shaped session/view
// ids. Deliberately excludes quotes, backslashes, semicolons, SQL comment
// markers (`--`, `/*`) and any other character not needed by a real value —
// this is an allow-list, not a blocklist.
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

function escapeSqlLiteral(value) {
  if (typeof value !== "string" || !SAFE_VALUE_PATTERN.test(value)) {
    throw new TemplateError(TEMPLATE_ERROR_REASON.UNSAFE_VALUE, JSON.stringify(value));
  }
  return `'${value.replaceAll("'", "''")}'`;
}

const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A fixed, catalog-authored reference to one of a dashboard's own
 * `variables.list` entries (e.g. `$session_id`), for panels meant to be
 * interactively re-scoped from OpenObserve's own dashboard UI — never a
 * carrier for caller-supplied/runtime text. docs/openobserve-v0.91-dashboard-capabilities.md
 * capability #13/#13a: this repo has not independently verified OpenObserve's
 * own `$name` substitution behavior against the pinned build (that only
 * happens inside the real web UI), so this is used only where the
 * alternative (a hardcoded, install-time-only value) would be actively
 * wrong, and is always documented as unverified at the point of use.
 */
export class DashboardVariableToken {
  constructor(name) {
    if (typeof name !== "string" || !VARIABLE_NAME_PATTERN.test(name)) {
      throw new TemplateError(
        TEMPLATE_ERROR_REASON.UNSAFE_VALUE,
        `invalid variable token name: ${JSON.stringify(name)}`,
      );
    }
    this.name = name;
  }

  toSql() {
    return `'$${this.name}'`;
  }
}

function renderValue(value) {
  if (value instanceof DashboardVariableToken) return value.toSql();
  return escapeSqlLiteral(value);
}

function requireVariable(variables, name) {
  const value = variables[name];
  if (value instanceof DashboardVariableToken) return value;
  if (typeof value !== "string" || value.length === 0) {
    throw new TemplateError(TEMPLATE_ERROR_REASON.MISSING_REQUIRED_VARIABLE, name);
  }
  return value;
}

/**
 * Renders one query manifest's sqlTemplate against a caller-supplied
 * variables object (keyed by the manifest's own variable names, e.g.
 * `variables.service`, `variables.session_id`). Returns the final,
 * execution-ready SQL string. Throws TemplateError on any missing required
 * variable, unsafe value, or leftover unresolved placeholder.
 */
export function renderQueryTemplate(manifest, variables = {}) {
  let sql = manifest.sqlTemplate;

  for (const name of manifest.requiredVariables ?? []) {
    const value = requireVariable(variables, name);
    sql = sql.replaceAll(`{{${name}}}`, renderValue(value));
  }

  for (const name of manifest.drilldownVariables ?? []) {
    const value = requireVariable(variables, name);
    sql = sql.replaceAll(`{{${name}}}`, renderValue(value));
  }

  for (const optional of manifest.optionalVariables ?? []) {
    const value = variables[optional.name];
    const clause =
      typeof value === "string" && value.length > 0
        ? ` and ${optional.column} = ${escapeSqlLiteral(value)}`
        : "";
    sql = sql.replaceAll(optional.clausePlaceholder, clause);
  }

  const unresolved = sql.match(/\{\{[^}]*\}\}/);
  if (unresolved) {
    throw new TemplateError(TEMPLATE_ERROR_REASON.UNRESOLVED_PLACEHOLDER, unresolved[0]);
  }

  return sql;
}

export function validateTimeRange(ceilingHours, startUs, endUs) {
  if (!Number.isInteger(startUs) || !Number.isInteger(endUs) || endUs <= startUs) {
    return { ok: false, reason: "INVALID_TIME_RANGE" };
  }
  const ceilingUs = ceilingHours * 60 * 60 * 1_000_000;
  if (endUs - startUs > ceilingUs) {
    return { ok: false, reason: "TIME_RANGE_EXCEEDS_CEILING" };
  }
  return { ok: true, reason: "OK" };
}
