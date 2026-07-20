import { describe, expect, it } from "vitest";

import { validateMetricCatalog } from "../../../scripts/lab/dashboards/metric-catalog.js";

function baseMetric(overrides = {}) {
  return {
    id: "sessions_count",
    queryId: "sessions-count",
    displayName: "Sessions",
    description: "Distinct sessions.",
    stream: "_rumdata",
    eventScope: "any",
    numerator: "count(distinct session_id)",
    denominator: null,
    unit: "count",
    aggregation: "count_distinct",
    requiredFilters: ["service", "environment"],
    emptyDataSemantics: "zero is real",
    timeRangeCeilingHours: 168,
    cardinalityRisk: "LOW",
    schemaDependencies: ["_rumdata.session_id"],
    alertReady: {
      alertReady: true,
      measurement: "sessions_count",
      windowPlaceholder: "TBD",
      minimumSampleSize: 1,
      thresholdDirection: "TBD",
      recoveryConditionPlaceholder: "TBD",
      grouping: ["service", "environment"],
      ownerPlaceholder: "TBD",
      runbookPlaceholder: "TBD",
    },
    ...overrides,
  };
}

const KNOWN_QUERY_IDS = new Set(["sessions-count"]);

describe("validateMetricCatalog", () => {
  it("accepts a well-formed catalog", () => {
    const result = validateMetricCatalog({ metrics: [baseMetric()] }, KNOWN_QUERY_IDS);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects a non-array/empty metrics list", () => {
    expect(validateMetricCatalog({ metrics: [] }, KNOWN_QUERY_IDS).valid).toBe(false);
    expect(validateMetricCatalog({}, KNOWN_QUERY_IDS).valid).toBe(false);
  });

  it("rejects a missing id", () => {
    const result = validateMetricCatalog({ metrics: [baseMetric({ id: "" })] }, KNOWN_QUERY_IDS);
    expect(result.errors).toContain("metric entry missing a non-empty id");
  });

  it("rejects a missing queryId", () => {
    const result = validateMetricCatalog(
      { metrics: [baseMetric({ queryId: "" })] },
      KNOWN_QUERY_IDS,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a queryId that does not match any known query manifest", () => {
    const result = validateMetricCatalog(
      { metrics: [baseMetric({ queryId: "does-not-exist" })] },
      KNOWN_QUERY_IDS,
    );
    expect(result.errors.some((error) => error.includes("does not match any query manifest"))).toBe(
      true,
    );
  });

  it("rejects a missing displayName", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ displayName: "" })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects a missing description", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ description: "" })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects a missing stream", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ stream: "" })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects a missing eventScope", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ eventScope: "" })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects a missing numerator", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ numerator: "" })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("accepts denominator: null and rejects a non-string, non-null denominator", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ denominator: null })] }, KNOWN_QUERY_IDS)
        .valid,
    ).toBe(true);
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ denominator: 5 })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects a missing unit", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ unit: "" })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects a missing aggregation", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ aggregation: "" })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects empty requiredFilters", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ requiredFilters: [] })] }, KNOWN_QUERY_IDS)
        .valid,
    ).toBe(false);
  });

  it("rejects requiredFilters missing 'service' or 'environment'", () => {
    expect(
      validateMetricCatalog(
        { metrics: [baseMetric({ requiredFilters: ["service"] })] },
        KNOWN_QUERY_IDS,
      ).valid,
    ).toBe(false);
    expect(
      validateMetricCatalog(
        { metrics: [baseMetric({ requiredFilters: ["environment"] })] },
        KNOWN_QUERY_IDS,
      ).valid,
    ).toBe(false);
  });

  it("rejects a missing emptyDataSemantics", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ emptyDataSemantics: "" })] }, KNOWN_QUERY_IDS)
        .valid,
    ).toBe(false);
  });

  it("rejects an out-of-range timeRangeCeilingHours", () => {
    expect(
      validateMetricCatalog(
        { metrics: [baseMetric({ timeRangeCeilingHours: 0 })] },
        KNOWN_QUERY_IDS,
      ).valid,
    ).toBe(false);
    expect(
      validateMetricCatalog(
        { metrics: [baseMetric({ timeRangeCeilingHours: 169 })] },
        KNOWN_QUERY_IDS,
      ).valid,
    ).toBe(false);
  });

  it("rejects a missing cardinalityRisk", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ cardinalityRisk: "" })] }, KNOWN_QUERY_IDS)
        .valid,
    ).toBe(false);
  });

  it("rejects empty schemaDependencies", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ schemaDependencies: [] })] }, KNOWN_QUERY_IDS)
        .valid,
    ).toBe(false);
  });

  it("rejects a non-object alertReady", () => {
    expect(
      validateMetricCatalog({ metrics: [baseMetric({ alertReady: null })] }, KNOWN_QUERY_IDS).valid,
    ).toBe(false);
  });

  it("rejects an alertReady object missing a required field", () => {
    const metric = baseMetric();
    delete metric.alertReady.runbookPlaceholder;
    expect(validateMetricCatalog({ metrics: [metric] }, KNOWN_QUERY_IDS).valid).toBe(false);
  });

  it("rejects a non-boolean alertReady.alertReady", () => {
    const metric = baseMetric({ alertReady: { ...baseMetric().alertReady, alertReady: "yes" } });
    expect(validateMetricCatalog({ metrics: [metric] }, KNOWN_QUERY_IDS).valid).toBe(false);
  });

  it("rejects a non-string-array alertReady.grouping", () => {
    const metric = baseMetric({ alertReady: { ...baseMetric().alertReady, grouping: "service" } });
    expect(validateMetricCatalog({ metrics: [metric] }, KNOWN_QUERY_IDS).valid).toBe(false);
  });

  it("accepts alertReady.minimumSampleSize: null and rejects a negative number", () => {
    const withNull = baseMetric({
      alertReady: { ...baseMetric().alertReady, minimumSampleSize: null },
    });
    expect(validateMetricCatalog({ metrics: [withNull] }, KNOWN_QUERY_IDS).valid).toBe(true);
    const withNegative = baseMetric({
      alertReady: { ...baseMetric().alertReady, minimumSampleSize: -1 },
    });
    expect(validateMetricCatalog({ metrics: [withNegative] }, KNOWN_QUERY_IDS).valid).toBe(false);
  });

  it("rejects a duplicate metric id", () => {
    const result = validateMetricCatalog(
      { metrics: [baseMetric(), baseMetric()] },
      KNOWN_QUERY_IDS,
    );
    expect(result.errors).toContain("duplicate metric id: sessions_count");
  });
});
