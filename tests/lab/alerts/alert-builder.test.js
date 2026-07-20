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

  it("keeps telemetry freshness and version regression disabled until company decisions exist", () => {
    const freshness = build({
      ...basePolicy,
      id: "telemetry-freshness",
      metricId: "last_observed_ingestion_age_rumdata",
      threshold: { starterValue: "REQUIRED_COMPANY_DECISION" },
      sample: { field: "last_event_us", minimum: 1 },
    });
    expect(freshness.query_condition.sql).toContain("last_event_us is not null and false");

    const version = build({
      ...basePolicy,
      id: "version-regression",
      metricId: "version_comparison",
      threshold: { absoluteStarterValue: 0.05 },
      sample: { minimumCurrent: 30, minimumBaseline: 30 },
    });
    expect(version.query_condition.sql).toContain(
      "current_sessions >= 30 and baseline_sessions >= 30 and false",
    );
  });
});
