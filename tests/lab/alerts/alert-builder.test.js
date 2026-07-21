import { describe, expect, it } from "vitest";

import { buildOpenObserveAlert } from "../../../scripts/lab/alerts/alert-builder.js";
import { parseMarker } from "../../../scripts/lab/alerts/marker.js";

const query = {
  sqlTemplate:
    "select count(*) as sessions, 0.3 as session_error_rate from _rumdata where service = {{service}} and env = {{environment}}{{version_clause}}",
};

const basePolicy = {
  schemaVersion: 1,
  id: "error-session-rate",
  name: "High error session rate",
  description: "desc",
  metricId: "session_error_rate",
  stream: "_rumdata",
  evaluation: { intervalMinutes: 1, lookbackMinutes: 10 },
  threshold: { starterValue: 0.2 },
  sample: { field: "sessions", minimum: 20 },
  breach: { requiredConsecutiveBreaches: 2 },
  cooldown: { minutes: 10 },
  severity: "high",
  deduplicationKey: "dedup",
  recoveryCondition: { direction: "below_or_equal", value: 0.1 },
  noDataPolicy: "NOT_HEALTHY",
  queryErrorPolicy: "NOT_HEALTHY",
  dashboardRef: "dashboard",
  runbookRef: "runbook",
};

function build(policy, override = {}) {
  return buildOpenObserveAlert(policy, override.query ?? query, {
    owner: "owner@example.test",
    scope: {
      service: "svc'quoted",
      environment: "lab",
      version: Object.hasOwn(override, "version") ? override.version : "1.2.3",
    },
    destinationName: "dest",
    templateName: "template",
  });
}

describe("buildOpenObserveAlert", () => {
  it("builds a disabled scheduled SQL alert with marker and safe context", () => {
    const alert = build(basePolicy);
    expect(alert.name).toBe("error-session-rate");
    expect(alert.enabled).toBe(false);
    expect(alert.is_real_time).toBe(false);
    expect(alert.destinations).toEqual(["dest"]);
    expect(alert.template).toBe("template");
    expect(alert.query_condition.sql).toContain("service = 'svc''quoted'");
    expect(alert.query_condition.sql).toContain("and version = '1.2.3'");
    expect(alert.query_condition.sql).toContain("sessions >= 20");
    expect(alert.query_condition.sql).toContain("session_error_rate > 0.2");
    expect(parseMarker(alert.description)).toEqual({
      starterId: "error-session-rate",
      starterVersion: 1,
    });
    expect(alert.context_attributes).toMatchObject({
      severity: "high",
      minimum_sample: "20",
      required_consecutive_breaches: "2",
      no_data_policy: "NOT_HEALTHY",
      query_error_policy: "NOT_HEALTHY",
    });
    // Folded into description because OpenObserve's real, pinned-build-verified
    // template tokens never include {alert_context_attributes.*} — only
    // {alert_description} is real (docs/openobserve-v0.91-alert-capabilities.md #16).
    expect(alert.description).toContain("severity=high");
    expect(alert.description).toContain("service=svc'quoted");
    expect(alert.description).toContain("environment=lab");
    expect(alert.description).toContain("version=1.2.3");
    expect(alert.description).toContain("dashboardRef=dashboard");
    expect(alert.description).toContain("runbookRef=runbook");
    expect(alert.description).toContain("dedupKey=dedup");
  });

  it("uses p75 for web vital candidate SQL and nullable version scope text", () => {
    const alert = build(
      {
        ...basePolicy,
        id: "web-vital-degradation",
        metricId: "web_vital_percentiles_lcp",
        threshold: { starterValue: 2500 },
        sample: { field: "sample_count", minimum: 30 },
      },
      { version: null },
    );
    expect(alert.query_condition.sql).toContain("p75 as zo_sql_val");
    expect(alert.query_condition.sql).toContain("sample_count >= 30");
    expect(alert.query_condition.sql).not.toContain("version =");
    expect(alert.context_attributes.version).toBe("bounded-by-alert-query");
  });

  it("keeps telemetry freshness disabled until a company decision exists", () => {
    const freshness = build({
      ...basePolicy,
      id: "telemetry-freshness",
      metricId: "last_observed_ingestion_age_rumdata",
      threshold: { starterValue: "REQUIRED_COMPANY_DECISION" },
      sample: { field: "freshness_seconds", minimum: 1 },
    });
    expect(freshness.query_condition.sql).toContain("freshness_seconds is not null and false");
  });

  it("renders placeholder threshold and current sample fallback when policy omits starter values", () => {
    const alert = build({
      ...basePolicy,
      threshold: {},
      sample: { field: "current_sessions", minimumCurrent: 10 },
    });
    expect(alert.context_attributes.threshold).toBe("REQUIRED_COMPANY_DECISION");
    expect(alert.context_attributes.sample_size).toBe("current_sessions >= 10");
    expect(alert.context_attributes.minimum_sample).toBe("10");
  });

  it("renders generic sample label when a policy uses only minimumCurrent", () => {
    const alert = build({
      ...basePolicy,
      sample: { minimumCurrent: 10 },
    });
    expect(alert.context_attributes.sample_size).toBe("current/baseline >= 10");
  });
});
