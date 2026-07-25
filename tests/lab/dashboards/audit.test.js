import { describe, expect, it } from "vitest";

import { auditDashboard, RISK_CLASS } from "../../../scripts/lab/dashboards/audit.js";

function dashboardWithPanel(panel, overrides = {}) {
  return {
    title: "Test Dashboard",
    description: "A normal description.",
    tabs: [{ tabId: "default", name: "Overview", panels: [panel] }],
    ...overrides,
  };
}

function overviewPanel(sql, overrides = {}) {
  return {
    id: "panel1",
    type: "table",
    title: "Panel",
    description: "",
    queries: [{ query: sql }],
    ...overrides,
  };
}

const OK_SQL =
  "select count(*) as sessions from _rumdata where service = 'browser-app' and env = 'lab' and type = 'view'";

describe("auditDashboard — PASS", () => {
  it("returns PASS with no findings for a clean overview query", () => {
    const result = auditDashboard(dashboardWithPanel(overviewPanel(OK_SQL)));
    expect(result).toEqual({ overall: RISK_CLASS.PASS, findings: [] });
  });

  it("returns PASS for a dashboard with no tabs/panels", () => {
    expect(auditDashboard({ title: "Empty", description: "", tabs: [] })).toEqual({
      overall: RISK_CLASS.PASS,
      findings: [],
    });
  });

  it("returns PASS for a dashboard with tabs but no panels array", () => {
    expect(
      auditDashboard({ title: "Empty", description: "", tabs: [{ tabId: "default", name: "x" }] }),
    ).toEqual({
      overall: RISK_CLASS.PASS,
      findings: [],
    });
  });

  it("returns PASS for a panel with no queries array", () => {
    const dashboard = dashboardWithPanel({ id: "p1", type: "table", title: "P", description: "" });
    expect(auditDashboard(dashboard)).toEqual({ overall: RISK_CLASS.PASS, findings: [] });
  });

  it("returns PASS for a dashboard with tabs omitted entirely", () => {
    expect(auditDashboard({ title: "Empty", description: "" })).toEqual({
      overall: RISK_CLASS.PASS,
      findings: [],
    });
  });

  it("treats a query object with no 'query' field as an empty SQL string (flagged as incomplete, not a crash)", () => {
    const dashboard = dashboardWithPanel(overviewPanel(undefined));
    const result = auditDashboard(dashboard);
    expect(
      result.findings.some((f) =>
        f.message.includes("missing a required service/environment filter"),
      ),
    ).toBe(true);
  });

  it("ignores non-string/empty title and description", () => {
    expect(auditDashboard({ title: null, description: undefined, tabs: [] }).overall).toBe(
      RISK_CLASS.PASS,
    );
  });

  it("does not flag a drilldown query's SELECT * or missing service/environment filter", () => {
    const sql =
      "select * from _rumdata where session_id = 'abc-123' order by _timestamp asc limit 200";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.overall).toBe(RISK_CLASS.PASS);
  });

  it("does not flag an aggregate query with no LIMIT", () => {
    const result = auditDashboard(dashboardWithPanel(overviewPanel(OK_SQL)));
    expect(result.findings.some((f) => f.message.includes("row LIMIT"))).toBe(false);
  });

  it("does not flag a bounded literal _timestamp range within the 168h ceiling", () => {
    const sql = `select * from _rumdata where session_id = 'x' and _timestamp between 0 and ${60 * 60 * 1_000_000} order by _timestamp limit 10`;
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("168h ceiling"))).toBe(false);
  });
});

describe("auditDashboard — PRIVACY_RISK", () => {
  it("flags a forbidden field name in query text", () => {
    const sql = "select user from _rumdata where service = 'browser-app' and env = 'lab' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.overall).toBe(RISK_CLASS.PRIVACY_RISK);
  });

  it("flags a forbidden field name in the dashboard title", () => {
    const result = auditDashboard(
      dashboardWithPanel(overviewPanel(OK_SQL), { title: "user report" }),
    );
    expect(result.findings.some((f) => f.class === RISK_CLASS.PRIVACY_RISK)).toBe(true);
  });

  it("flags a forbidden field name in the dashboard description", () => {
    const result = auditDashboard(
      dashboardWithPanel(overviewPanel(OK_SQL), { description: "shows account data" }),
    );
    expect(result.findings.some((f) => f.class === RISK_CLASS.PRIVACY_RISK)).toBe(true);
  });

  it("flags a forbidden field name in a panel title/description", () => {
    const panel = overviewPanel(OK_SQL, { title: "user panel", description: "shows payload" });
    const result = auditDashboard(dashboardWithPanel(panel));
    expect(
      result.findings.filter((f) => f.class === RISK_CLASS.PRIVACY_RISK).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("auditDashboard — SECURITY_RISK", () => {
  it("flags a credential-shaped field pattern in SQL", () => {
    const sql =
      "select auth_token from _rumdata where service = 'browser-app' and env = 'lab' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.overall).toBe(RISK_CLASS.SECURITY_RISK);
  });

  it("flags a raw credential-shaped value in SQL", () => {
    const sql =
      "select * from _rumdata where session_id = 'x' and note = 'bearer abcdefghij1234567890' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("raw credential"))).toBe(true);
  });

  it("flags Session Replay referenced in SQL", () => {
    const sql = "select * from _rumreplay where service = 'browser-app' and env = 'lab' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("Session Replay"))).toBe(true);
  });

  it("does NOT flag Session Replay mentioned only in prose (title/description)", () => {
    const result = auditDashboard(
      dashboardWithPanel(overviewPanel(OK_SQL), {
        description: "No Session Replay panel is included in this dashboard.",
      }),
    );
    expect(result.findings.some((f) => f.message.includes("Session Replay"))).toBe(false);
  });

  it("flags a guaranteed-delivery claim in SQL", () => {
    const sql =
      "select 'guaranteed delivery' as note from _rumdata where service = 'browser-app' and env = 'lab' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("guaranteed-delivery"))).toBe(true);
  });

  it("flags a statement separator in SQL", () => {
    const sql =
      "select count(*) as c from _rumdata where service = 'browser-app' and env = 'lab'; drop table x";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("statement separator"))).toBe(true);
  });

  it("does NOT flag a semicolon appearing only in title/description prose", () => {
    const result = auditDashboard(
      dashboardWithPanel(overviewPanel(OK_SQL), { description: "0-1 ratio; NO_DATA when empty." }),
    );
    expect(result.findings.some((f) => f.message.includes("statement separator"))).toBe(false);
  });

  it("flags a SQL comment marker", () => {
    const sql =
      "select count(*) as c from _rumdata where service = 'browser-app' and env = 'lab' -- sneaky";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("comment marker"))).toBe(true);
  });

  it("flags a block-comment marker", () => {
    const sql =
      "select count(*) as c from _rumdata where service = 'browser-app' /* x */ and env = 'lab'";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("comment marker"))).toBe(true);
  });

  it.each([undefined, null, "not-an-object", 42, [1, 2, 3]])(
    "flags a non-object dashboard root instead of crashing: %p",
    (dashboard) => {
      const result = auditDashboard(dashboard);
      expect(result.overall).toBe(RISK_CLASS.SECURITY_RISK);
      expect(result.findings[0].message).toContain("dashboard body is not a valid object");
    },
  );

  it.each([null, 42, "not-an-object"])(
    "flags a non-object tab entry instead of crashing: %p",
    (tab) => {
      const result = auditDashboard({ title: "x", tabs: [tab] });
      expect(result.overall).toBe(RISK_CLASS.SECURITY_RISK);
      expect(
        result.findings.some((f) => f.message.includes("tab entry is not a valid object")),
      ).toBe(true);
    },
  );

  it.each([null, 42, "not-an-object"])(
    "flags a non-object panel entry instead of crashing: %p",
    (panel) => {
      const result = auditDashboard({ title: "x", tabs: [{ panels: [panel] }] });
      expect(result.overall).toBe(RISK_CLASS.SECURITY_RISK);
      expect(
        result.findings.some((f) => f.message.includes("panel entry is not a valid object")),
      ).toBe(true);
    },
  );

  it("flags a non-string query field instead of crashing", () => {
    const dashboard = dashboardWithPanel({
      id: "p1",
      type: "table",
      title: "P",
      description: "",
      queries: [{ query: 12345 }],
    });
    const result = auditDashboard(dashboard);
    expect(result.overall).toBe(RISK_CLASS.SECURITY_RISK);
    expect(result.findings.some((f) => f.message.includes("query field is not a string"))).toBe(
      true,
    );
  });
});

describe("auditDashboard — QUERY_RISK", () => {
  it("flags SELECT * on a non-drilldown query", () => {
    const sql = "select * from _rumdata where service = 'browser-app' and env = 'lab' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("SELECT *"))).toBe(true);
  });

  it("flags a missing service filter", () => {
    const sql = "select count(*) as c from _rumdata where env = 'lab' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("service/environment filter"))).toBe(
      true,
    );
  });

  it("flags a missing environment filter", () => {
    const sql = "select count(*) as c from _rumdata where service = 'browser-app' limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("service/environment filter"))).toBe(
      true,
    );
  });

  it("accepts $service/$environment dashboard-variable tokens as satisfying the filter requirement", () => {
    const sql =
      "select count(*) as c from _rumdata where service = $service and env = $environment limit 10";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("service/environment filter"))).toBe(
      false,
    );
  });

  it("flags a non-aggregate query with no LIMIT", () => {
    const sql = "select error_type from _rumdata where service = 'browser-app' and env = 'lab'";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("no row LIMIT"))).toBe(true);
  });

  it("flags a literal _timestamp range exceeding the 168h ceiling", () => {
    const tooWide = 168 * 60 * 60 * 1_000_000 + 1;
    const sql = `select * from _rumdata where session_id = 'x' and _timestamp between 0 and ${tooWide} order by _timestamp limit 10`;
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.message.includes("168h ceiling"))).toBe(true);
  });

  it("flags a live query execution failure supplied via queryResults", () => {
    const result = auditDashboard(dashboardWithPanel(overviewPanel(OK_SQL)), {
      queryResults: { panel1: { status: 400, error: "syntax error" } },
    });
    expect(result.findings.some((f) => f.message.includes("query execution failed"))).toBe(true);
  });

  it("falls back to a generic message when a failed queryResults entry has no error field", () => {
    const result = auditDashboard(dashboardWithPanel(overviewPanel(OK_SQL)), {
      queryResults: { panel1: { status: 500 } },
    });
    expect(result.findings.some((f) => f.message.includes("unknown error"))).toBe(true);
  });

  it("does not flag a successful (status 200) live execution result", () => {
    const result = auditDashboard(dashboardWithPanel(overviewPanel(OK_SQL)), {
      queryResults: { panel1: { status: 200 } },
    });
    expect(result.findings.some((f) => f.message.includes("query execution failed"))).toBe(false);
  });

  it("ignores queryResults with no entry for a panel", () => {
    const result = auditDashboard(dashboardWithPanel(overviewPanel(OK_SQL)), { queryResults: {} });
    expect(result.overall).toBe(RISK_CLASS.PASS);
  });

  it("works with queryResults omitted entirely", () => {
    const result = auditDashboard(dashboardWithPanel(overviewPanel(OK_SQL)));
    expect(result.overall).toBe(RISK_CLASS.PASS);
  });
});

describe("auditDashboard — CARDINALITY_RISK", () => {
  it("flags GROUP BY on a high-cardinality field", () => {
    const sql =
      "select session_id, count(*) as c from _rumdata where service = 'browser-app' and env = 'lab' group by session_id order by c limit 20";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.class === RISK_CLASS.CARDINALITY_RISK)).toBe(true);
  });

  it("does not flag GROUP BY on a low-cardinality field", () => {
    const sql =
      "select status, count(*) as c from _rumlog where service = 'browser-app' and env = 'lab' group by status order by c limit 20";
    const result = auditDashboard(dashboardWithPanel(overviewPanel(sql)));
    expect(result.findings.some((f) => f.class === RISK_CLASS.CARDINALITY_RISK)).toBe(false);
  });
});

describe("auditDashboard — UNSUPPORTED_FEATURE", () => {
  it("flags a custom JavaScript chart panel type", () => {
    const panel = overviewPanel(OK_SQL, { type: "custom_chart" });
    const result = auditDashboard(dashboardWithPanel(panel));
    expect(result.overall).toBe(RISK_CLASS.UNSUPPORTED_FEATURE);
  });
});

describe("auditDashboard — severity ordering", () => {
  it("reports the highest-severity class as overall when multiple risks are present", () => {
    const sql =
      "select user, auth_token, session_id, count(*) as c from _rumdata where env = 'lab' group by session_id"; // security + privacy + query + cardinality risks
    const panel = overviewPanel(sql, { type: "custom_chart" });
    const result = auditDashboard(dashboardWithPanel(panel));
    expect(result.overall).toBe(RISK_CLASS.SECURITY_RISK);
    const classes = result.findings.map((f) => f.class);
    expect(classes).toContain(RISK_CLASS.PRIVACY_RISK);
    expect(classes).toContain(RISK_CLASS.QUERY_RISK);
    expect(classes).toContain(RISK_CLASS.CARDINALITY_RISK);
    expect(classes).toContain(RISK_CLASS.UNSUPPORTED_FEATURE);
  });
});
