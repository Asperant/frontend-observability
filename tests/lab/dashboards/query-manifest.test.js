import { describe, expect, it } from "vitest";

import {
  CARDINALITY_CLASS,
  HIGH_CARDINALITY_FIELDS,
  MAX_TIME_RANGE_CEILING_HOURS,
  QUERY_CLASS,
  validateQueryManifest,
} from "../../../scripts/lab/dashboards/query-manifest.js";

function baseOverview(overrides = {}) {
  return {
    id: "sessions-count",
    version: 1,
    metricId: "sessions_count",
    title: "Sessions count",
    queryClass: QUERY_CLASS.OVERVIEW,
    stream: "_rumdata",
    sqlTemplate:
      "select count(distinct session_id) as sessions from _rumdata where service = {{service}} and env = {{environment}}",
    requiredVariables: ["service", "environment"],
    optionalVariables: [],
    drilldownVariables: [],
    timeRangeCeilingHours: 168,
    rowLimit: null,
    timeoutBudgetMs: 10000,
    expectedColumns: [{ name: "sessions", type: "Int64" }],
    emptyDataSemantics: "zero is a real zero",
    cardinalityClass: CARDINALITY_CLASS.LOW_CARDINALITY_OVERVIEW,
    hasDivisionGuard: false,
    ...overrides,
  };
}

describe("validateQueryManifest — shape", () => {
  it("accepts a well-formed overview manifest", () => {
    expect(validateQueryManifest(baseOverview())).toEqual({ valid: true, errors: [] });
  });

  it("accepts metricId: null", () => {
    expect(validateQueryManifest(baseOverview({ metricId: null })).valid).toBe(true);
  });

  it("rejects a missing id", () => {
    expect(validateQueryManifest(baseOverview({ id: "" })).valid).toBe(false);
  });

  it("rejects a non-positive-integer version", () => {
    expect(validateQueryManifest(baseOverview({ version: 0 })).valid).toBe(false);
  });

  it("rejects an invalid metricId (not null, not a string)", () => {
    expect(validateQueryManifest(baseOverview({ metricId: 5 })).valid).toBe(false);
  });

  it("rejects a missing title", () => {
    expect(validateQueryManifest(baseOverview({ title: "" })).valid).toBe(false);
  });

  it("rejects an invalid queryClass", () => {
    expect(validateQueryManifest(baseOverview({ queryClass: "BOGUS" })).valid).toBe(false);
  });

  it("rejects a missing stream", () => {
    expect(validateQueryManifest(baseOverview({ stream: "" })).valid).toBe(false);
  });

  it("rejects a missing sqlTemplate and stops before SQL-text checks", () => {
    const result = validateQueryManifest(baseOverview({ sqlTemplate: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("sqlTemplate must be a non-empty string");
  });

  it("rejects a non-array requiredVariables", () => {
    expect(validateQueryManifest(baseOverview({ requiredVariables: "service" })).valid).toBe(false);
  });

  it("rejects a non-array optionalVariables", () => {
    expect(validateQueryManifest(baseOverview({ optionalVariables: null })).valid).toBe(false);
  });

  it("rejects a non-array drilldownVariables", () => {
    expect(validateQueryManifest(baseOverview({ drilldownVariables: null })).valid).toBe(false);
  });

  it("rejects a timeRangeCeilingHours of 0", () => {
    expect(validateQueryManifest(baseOverview({ timeRangeCeilingHours: 0 })).valid).toBe(false);
  });

  it(`rejects a timeRangeCeilingHours above ${MAX_TIME_RANGE_CEILING_HOURS}`, () => {
    expect(validateQueryManifest(baseOverview({ timeRangeCeilingHours: 169 })).valid).toBe(false);
  });

  it("rejects a negative rowLimit", () => {
    expect(validateQueryManifest(baseOverview({ rowLimit: -1 })).valid).toBe(false);
  });

  it("rejects a non-positive timeoutBudgetMs", () => {
    expect(validateQueryManifest(baseOverview({ timeoutBudgetMs: 0 })).valid).toBe(false);
  });

  it("rejects a non-array expectedColumns", () => {
    expect(validateQueryManifest(baseOverview({ expectedColumns: null })).valid).toBe(false);
  });

  it("rejects a missing emptyDataSemantics", () => {
    expect(validateQueryManifest(baseOverview({ emptyDataSemantics: "" })).valid).toBe(false);
  });

  it("rejects an invalid cardinalityClass", () => {
    expect(validateQueryManifest(baseOverview({ cardinalityClass: "BOGUS" })).valid).toBe(false);
  });

  it("rejects a non-boolean hasDivisionGuard", () => {
    expect(validateQueryManifest(baseOverview({ hasDivisionGuard: "yes" })).valid).toBe(false);
  });

  it("stops before SQL-text checks when queryClass itself is invalid, even with a valid sqlTemplate", () => {
    const result = validateQueryManifest(baseOverview({ queryClass: "BOGUS" }));
    expect(result.valid).toBe(false);
  });
});

describe("validateQueryManifest — SQL safety, overview/table", () => {
  it("rejects SELECT * on an overview query", () => {
    const result = validateQueryManifest(
      baseOverview({
        sqlTemplate: "select * from _rumdata where service = {{service}} and env = {{environment}}",
      }),
    );
    expect(result.errors).toContain(
      "overview/table queries must use an explicit field list, not SELECT *",
    );
  });

  it("rejects a missing 'service' required variable", () => {
    const result = validateQueryManifest(baseOverview({ requiredVariables: ["environment"] }));
    expect(result.errors).toContain("overview/table queries must require the 'service' variable");
  });

  it("rejects a missing 'environment' required variable", () => {
    const result = validateQueryManifest(baseOverview({ requiredVariables: ["service"] }));
    expect(result.errors).toContain(
      "overview/table queries must require the 'environment' variable",
    );
  });

  it("rejects an overview/table query that declares drilldownVariables", () => {
    const result = validateQueryManifest(baseOverview({ drilldownVariables: ["session_id"] }));
    expect(result.errors).toContain("overview/table queries must not declare drilldownVariables");
  });

  it("rejects an overview query that declares a rowLimit", () => {
    const result = validateQueryManifest(baseOverview({ rowLimit: 10 }));
    expect(result.errors).toContain(
      "overview queries must not declare a rowLimit (single-row aggregate)",
    );
  });

  it("accepts a well-formed table query", () => {
    const manifest = baseOverview({
      queryClass: QUERY_CLASS.TABLE,
      sqlTemplate:
        "select status, count(*) as c from _rumlog where service = {{service}} and env = {{environment}} group by status order by c desc limit 20",
      rowLimit: 20,
      cardinalityClass: CARDINALITY_CLASS.BOUNDED_TABLE,
    });
    expect(validateQueryManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a table query with no rowLimit", () => {
    const manifest = baseOverview({
      queryClass: QUERY_CLASS.TABLE,
      sqlTemplate:
        "select status, count(*) as c from _rumlog where service = {{service}} and env = {{environment}} group by status order by c limit 20",
      rowLimit: null,
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "table queries must declare a positive rowLimit",
    );
  });

  it("rejects a table query with no GROUP BY", () => {
    const manifest = baseOverview({
      queryClass: QUERY_CLASS.TABLE,
      sqlTemplate:
        "select status from _rumlog where service = {{service}} and env = {{environment}} order by status limit 20",
      rowLimit: 20,
    });
    expect(validateQueryManifest(manifest).errors).toContain("table queries must use GROUP BY");
  });

  it("rejects a table query with no ORDER BY", () => {
    const manifest = baseOverview({
      queryClass: QUERY_CLASS.TABLE,
      sqlTemplate:
        "select status, count(*) as c from _rumlog where service = {{service}} and env = {{environment}} group by status limit 20",
      rowLimit: 20,
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "table queries must use ORDER BY for deterministic ordering",
    );
  });

  it("rejects a table query with no LIMIT", () => {
    const manifest = baseOverview({
      queryClass: QUERY_CLASS.TABLE,
      sqlTemplate:
        "select status, count(*) as c from _rumlog where service = {{service}} and env = {{environment}} group by status order by c",
      rowLimit: 20,
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "table queries must use an explicit LIMIT",
    );
  });

  it("rejects a GROUP BY on a high-cardinality field", () => {
    const manifest = baseOverview({
      queryClass: QUERY_CLASS.TABLE,
      sqlTemplate: `select session_id, count(*) as c from _rumdata where service = {{service}} and env = {{environment}} group by ${HIGH_CARDINALITY_FIELDS[0]} order by c limit 20`,
      rowLimit: 20,
    });
    expect(
      validateQueryManifest(manifest).errors.some((error) =>
        error.includes("high-cardinality field"),
      ),
    ).toBe(true);
  });

  it("rejects a hasDivisionGuard:true query missing the CASE/NULL guard", () => {
    const manifest = baseOverview({ hasDivisionGuard: true });
    expect(
      validateQueryManifest(manifest).errors.some((error) => error.includes("CASE ... NULL")),
    ).toBe(true);
  });

  it("accepts a hasDivisionGuard:true query with a real CASE/NULL guard", () => {
    const manifest = baseOverview({
      hasDivisionGuard: true,
      sqlTemplate:
        "select case when count(*) = 0 then null else count(*) end as rate from _rumdata where service = {{service}} and env = {{environment}}",
    });
    expect(validateQueryManifest(manifest).valid).toBe(true);
  });

  it("rejects an unrecognized placeholder token", () => {
    const manifest = baseOverview({
      sqlTemplate:
        "select {{bogus}} from _rumdata where service = {{service}} and env = {{environment}}",
    });
    expect(
      validateQueryManifest(manifest).errors.some((error) =>
        error.includes("unrecognized placeholder"),
      ),
    ).toBe(true);
  });

  it("rejects a statement separator", () => {
    const manifest = baseOverview({
      sqlTemplate:
        "select count(*) as c from _rumdata where service = {{service}} and env = {{environment}}; drop table x",
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "sqlTemplate must not contain a statement separator (;)",
    );
  });

  it("rejects a SQL comment marker", () => {
    const manifest = baseOverview({
      sqlTemplate:
        "select count(*) as c from _rumdata where service = {{service}} and env = {{environment}} -- comment",
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "sqlTemplate must not contain a SQL comment marker",
    );
  });

  it("accepts a query whose SQL contains no placeholder tokens at all", () => {
    const manifest = baseOverview({
      sqlTemplate: "select count(*) as c from _rumdata where service = 'x' and env = 'y'",
    });
    expect(validateQueryManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it("accepts an optional variable's clause placeholder as allowed", () => {
    const manifest = baseOverview({
      optionalVariables: [
        { name: "version", column: "version", clausePlaceholder: "{{version_clause}}" },
      ],
      sqlTemplate:
        "select count(*) as c from _rumdata where service = {{service}} and env = {{environment}}{{version_clause}}",
    });
    expect(validateQueryManifest(manifest).valid).toBe(true);
  });
});

describe("validateQueryManifest — SQL safety, list", () => {
  function baseList(overrides = {}) {
    return baseOverview({
      queryClass: QUERY_CLASS.LIST,
      sqlTemplate:
        "select _timestamp, error_type from _rumdata where service = {{service}} and env = {{environment}} order by _timestamp desc limit 20",
      rowLimit: 20,
      cardinalityClass: CARDINALITY_CLASS.BOUNDED_LIST,
      ...overrides,
    });
  }

  it("accepts a well-formed list query", () => {
    expect(validateQueryManifest(baseList())).toEqual({ valid: true, errors: [] });
  });

  it("rejects a list query with no rowLimit", () => {
    expect(validateQueryManifest(baseList({ rowLimit: null })).errors).toContain(
      "list queries must declare a positive rowLimit",
    );
  });

  it("rejects a list query with no ORDER BY", () => {
    const manifest = baseList({
      sqlTemplate:
        "select _timestamp, error_type from _rumdata where service = {{service}} and env = {{environment}} limit 20",
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "list queries must use ORDER BY for deterministic ordering",
    );
  });

  it("rejects a list query with no LIMIT", () => {
    const manifest = baseList({
      sqlTemplate:
        "select _timestamp, error_type from _rumdata where service = {{service}} and env = {{environment}} order by _timestamp desc",
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "list queries must use an explicit LIMIT",
    );
  });
});

describe("validateQueryManifest — SQL safety, drilldown", () => {
  function baseDrilldown(overrides = {}) {
    return {
      id: "session-errors-drilldown",
      version: 1,
      metricId: null,
      title: "Session errors",
      queryClass: QUERY_CLASS.DRILLDOWN,
      stream: "_rumdata",
      sqlTemplate:
        "select * from _rumdata where session_id = {{session_id}} order by _timestamp asc limit 200",
      requiredVariables: [],
      optionalVariables: [],
      drilldownVariables: ["session_id"],
      timeRangeCeilingHours: 168,
      rowLimit: 200,
      timeoutBudgetMs: 10000,
      expectedColumns: [],
      emptyDataSemantics: "empty is empty",
      cardinalityClass: CARDINALITY_CLASS.BOUNDED_DRILLDOWN,
      hasDivisionGuard: false,
      ...overrides,
    };
  }

  it("accepts a well-formed list-style drilldown query using SELECT *", () => {
    expect(validateQueryManifest(baseDrilldown())).toEqual({ valid: true, errors: [] });
  });

  it("accepts a single-row drilldown query with rowLimit: null and no ORDER BY", () => {
    const manifest = baseDrilldown({
      sqlTemplate: "select count(*) as c from _rumdata where session_id = {{session_id}}",
      rowLimit: null,
    });
    expect(validateQueryManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a drilldown query that declares requiredVariables", () => {
    const manifest = baseDrilldown({ requiredVariables: ["service"] });
    expect(validateQueryManifest(manifest).errors).toContain(
      "drilldown queries must not declare requiredVariables (service/environment)",
    );
  });

  it("rejects a drilldown query with no drilldownVariables", () => {
    const manifest = baseDrilldown({ drilldownVariables: [] });
    expect(validateQueryManifest(manifest).errors).toContain(
      "drilldown queries must declare at least one drilldownVariable",
    );
  });

  it("rejects a list-style drilldown query (rowLimit set) missing ORDER BY", () => {
    const manifest = baseDrilldown({
      sqlTemplate: "select * from _rumdata where session_id = {{session_id}} limit 200",
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "list-style drilldown queries must use ORDER BY for deterministic ordering",
    );
  });

  it("rejects a list-style drilldown query (rowLimit set) missing LIMIT", () => {
    const manifest = baseDrilldown({
      sqlTemplate:
        "select * from _rumdata where session_id = {{session_id}} order by _timestamp asc",
    });
    expect(validateQueryManifest(manifest).errors).toContain(
      "list-style drilldown queries must use an explicit LIMIT",
    );
  });
});
