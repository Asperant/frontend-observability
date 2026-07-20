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
});
