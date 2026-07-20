import { describe, expect, it } from "vitest";

import { RISK_CLASS, auditAlertDefinition } from "../../../scripts/lab/alerts/audit.js";

const safeAlert = {
  name: "safe",
  owner: "owner",
  destinations: ["dest"],
  enabled: false,
  trigger_condition: { period: 10, frequency: 1, silence: 10 },
  query_condition: { sql: "select count(*) from _rumdata where service = 'demo' and env = 'lab'" },
  context_attributes: {
    runbook_ref: "runbook",
    minimum_sample: "20",
    required_consecutive_breaches: "2",
    dedup_key: "dedup",
    recovery_condition: "recover",
  },
};

describe("auditAlertDefinition", () => {
  it("passes safe aggregate alerts", () => {
    expect(auditAlertDefinition(safeAlert)).toEqual({ class: RISK_CLASS.PASS, findings: [] });
  });

  it("flags routing, noise, query, privacy, security, and unsupported risks", () => {
    const result = auditAlertDefinition({
      name: "unsafe",
      owner: "REQUIRED_COMPANY_OWNER",
      destinations: [],
      enabled: true,
      trigger_condition: { period: 168 * 60 + 1, frequency: 0, silence: 0 },
      query_condition: {
        sql: "select * from _rumdata where service = '{{service}}'; -- bad group by session_id",
      },
      context_attributes: {},
      row_template: "{rows}",
      description: "session replay guaranteed delivery custom javascript token",
      productionDecision: "REQUIRED_COMPANY_DECISION",
    });
    expect(result.findings.map((finding) => finding.class)).toEqual(
      expect.arrayContaining([
        RISK_CLASS.ROUTING_RISK,
        RISK_CLASS.NOISE_RISK,
        RISK_CLASS.QUERY_RISK,
        RISK_CLASS.PRIVACY_RISK,
        RISK_CLASS.SECURITY_RISK,
        RISK_CLASS.UNSUPPORTED_FEATURE,
        RISK_CLASS.WARNING,
      ]),
    );
  });

  it("flags a missing service filter separately", () => {
    const result = auditAlertDefinition({
      ...safeAlert,
      query_condition: { sql: "select count(*) from _rumdata where env = 'lab'" },
    });
    expect(result.findings).toContainEqual({
      class: RISK_CLASS.QUERY_RISK,
      message: "service filter is missing",
    });
  });

  it("allows aggregate session counts but flags raw sensitive projections", () => {
    const aggregate = auditAlertDefinition({
      ...safeAlert,
      query_condition: {
        sql: "select count(distinct session_id) as sessions from _rumdata where service = 'demo' and env = 'lab'",
      },
    });
    expect(aggregate.findings).not.toContainEqual({
      class: RISK_CLASS.PRIVACY_RISK,
      message: "sensitive/raw field appears in alert",
    });

    const rawProjection = auditAlertDefinition({
      ...safeAlert,
      query_condition: {
        sql: "select session_id from _rumdata where service = 'demo' and env = 'lab'",
      },
    });
    expect(rawProjection.findings).toContainEqual({
      class: RISK_CLASS.PRIVACY_RISK,
      message: "sensitive/raw field appears in alert",
    });
  });

  it("handles missing trigger/query and high-cardinality grouping", () => {
    const result = auditAlertDefinition({
      name: "minimal",
      context_attributes: {
        runbook_ref: "runbook",
        minimum_sample: "20",
        required_consecutive_breaches: "2",
        dedup_key: "dedup",
        recovery_condition: "recover",
      },
    });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        { class: RISK_CLASS.QUERY_RISK, message: "lookback period is missing or too wide" },
        { class: RISK_CLASS.QUERY_RISK, message: "service filter is missing" },
        { class: RISK_CLASS.QUERY_RISK, message: "environment filter is missing" },
      ]),
    );

    const groupBy = auditAlertDefinition({
      ...safeAlert,
      query_condition: {
        sql: "select count(*) from _rumdata where service = 'demo' and env = 'lab' group by session_id",
      },
    });
    expect(groupBy.findings).toContainEqual({
      class: RISK_CLASS.QUERY_RISK,
      message: "query groups by high-cardinality fields",
    });
  });

  it("does not crash when query_condition.sql is a non-string value", () => {
    const result = auditAlertDefinition({ ...safeAlert, query_condition: { sql: 12345 } });
    expect(result.findings.some((f) => f.message === "sensitive/raw field appears in alert")).toBe(
      false,
    );
  });

  it("does not flag a raw sensitive projection when the SQL has no SELECT...FROM shape to inspect", () => {
    const result = auditAlertDefinition({
      ...safeAlert,
      query_condition: { sql: "not a select statement at all" },
    });
    expect(result.findings.some((f) => f.message === "sensitive/raw field appears in alert")).toBe(
      false,
    );
  });

  it.each([undefined, null, "not-an-object", 42, [1, 2, 3]])(
    "flags a non-object alert root instead of crashing: %p",
    (alert) => {
      const result = auditAlertDefinition(alert);
      expect(result.class).toBe(RISK_CLASS.SECURITY_RISK);
      expect(result.findings[0].message).toContain("alert definition is not a valid object");
    },
  );

  it("flags a circular alert structure instead of crashing on JSON.stringify", () => {
    const circular = { ...safeAlert };
    circular.self = circular;
    const result = auditAlertDefinition(circular);
    expect(
      result.findings.some((f) => f.message.includes("could not be serialized for scanning")),
    ).toBe(true);
  });

  it("flags a circular notification-field structure instead of crashing on JSON.stringify", () => {
    const circularContext = {};
    circularContext.self = circularContext;
    const alert = { ...safeAlert, context_attributes: circularContext };
    const result = auditAlertDefinition(alert);
    expect(
      result.findings.some((f) => f.message.includes("could not be serialized for scanning")),
    ).toBe(true);
  });
});
