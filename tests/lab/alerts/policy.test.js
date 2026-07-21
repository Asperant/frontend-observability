import { describe, expect, it } from "vitest";

import {
  POLICY_STATUS,
  createAlertState,
  evaluatePolicySample,
  normalizeAlertExport,
  sampleMinimum,
  validateAlertPolicy,
} from "../../../scripts/lab/alerts/policy.js";

const basePolicy = {
  schemaVersion: 1,
  id: "error-session-rate",
  name: "High error session rate",
  description: "desc",
  metricId: "session_error_rate",
  queryId: "session-error-rate",
  stream: "_rumdata",
  severity: "high",
  enabledByDefault: false,
  requiredScope: { service: "REQUIRED", environment: "REQUIRED" },
  evaluation: { intervalMinutes: 1, lookbackMinutes: 10 },
  threshold: {
    direction: "above",
    starterValue: 0.2,
    productionValue: "REQUIRED_COMPANY_DECISION",
  },
  sample: { field: "sessions", minimum: 20 },
  breach: { requiredConsecutiveBreaches: 2 },
  cooldown: { minutes: 10 },
  deduplicationKey: "dedup",
  recoveryCondition: { direction: "below_or_equal", value: 0.1, requiredConsecutiveHealthy: 2 },
  noDataPolicy: "NOT_HEALTHY",
  queryErrorPolicy: "NOT_HEALTHY",
  destinationRef: "local-alert-sink",
  dashboardRef: "dash",
  runbookRef: "runbook",
  owner: "owner",
  productionDecision: { enabled: "REQUIRED_COMPANY_DECISION" },
};

function sample(row, extra = {}) {
  return { row, nowMinute: extra.nowMinute ?? 0, dedupKey: extra.dedupKey, ...extra };
}

describe("validateAlertPolicy", () => {
  it("accepts a governed starter policy", () => {
    expect(
      validateAlertPolicy(basePolicy, {
        knownMetricIds: new Set(["session_error_rate"]),
        knownQueryIds: new Set(["session-error-rate"]),
        knownDestinationRefs: new Set(["local-alert-sink"]),
      }),
    ).toEqual({ valid: true, errors: [] });
    expect(sampleMinimum(basePolicy)).toBe(20);
  });

  it("rejects unsafe or incomplete policies", () => {
    const policy = {
      ...basePolicy,
      severity: "urgent",
      enabledByDefault: true,
      noDataPolicy: "HEALTHY",
      queryErrorPolicy: "HEALTHY",
      evaluation: { intervalMinutes: 0, lookbackMinutes: 168 * 60 + 1 },
      sample: {},
      breach: {},
      cooldown: { minutes: 0 },
      recoveryCondition: null,
      description: "guaranteed delivery",
    };
    const result = validateAlertPolicy(policy, {
      knownMetricIds: new Set(),
      knownQueryIds: new Set(),
      knownDestinationRefs: new Set(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(10);
  });

  it("rejects missing lookback and unsupported delivery claims outside doesNotClaim", () => {
    const missingId = { ...basePolicy };
    delete missingId.id;
    expect(
      validateAlertPolicy(missingId, {
        knownMetricIds: new Set(["session_error_rate"]),
        knownQueryIds: new Set(["session-error-rate"]),
        knownDestinationRefs: new Set(["local-alert-sink"]),
      }).errors,
    ).toContain("missing required key: id");

    const result = validateAlertPolicy(
      { ...basePolicy, evaluation: { intervalMinutes: 1 }, description: "no event loss" },
      {
        knownMetricIds: new Set(["session_error_rate"]),
        knownQueryIds: new Set(["session-error-rate"]),
        knownDestinationRefs: new Set(["local-alert-sink"]),
      },
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "evaluation.lookbackMinutes must be >= 1",
        "policy must not claim Session Replay or guaranteed delivery",
      ]),
    );
  });
});

describe("evaluatePolicySample", () => {
  it("does not fire below threshold, below minimum sample, or on first breach", () => {
    let state = createAlertState();
    expect(
      evaluatePolicySample(basePolicy, sample({ sessions: 100, session_error_rate: 0.1 }), state)
        .state.status,
    ).toBe(POLICY_STATUS.HEALTHY);
    expect(
      evaluatePolicySample(basePolicy, sample({ sessions: 1, session_error_rate: 1 }), state).state
        .status,
    ).toBe(POLICY_STATUS.INSUFFICIENT_SAMPLE);
    state = createAlertState();
    const first = evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.3 }),
      state,
    );
    expect(first.state.status).toBe(POLICY_STATUS.PENDING);
    expect(first.notification).toBeNull();
  });

  it("fires once after consecutive breaches and dedups inside the same incident", () => {
    const state = createAlertState();
    evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.3 }, { nowMinute: 1 }),
      state,
    );
    const firing = evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.4 }, { nowMinute: 2 }),
      state,
    );
    expect(firing.notification).toEqual({ type: "firing", dedupKey: "dedup" });
    const duplicate = evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.5 }, { nowMinute: 20 }),
      state,
    );
    expect(duplicate.notification).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  it("enforces cooldown for a new dedup key", () => {
    const state = createAlertState();
    evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.3 }, { nowMinute: 1, dedupKey: "a" }),
      state,
    );
    evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.3 }, { nowMinute: 2, dedupKey: "a" }),
      state,
    );
    state.openDedupKey = null;
    const suppressed = evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.3 }, { nowMinute: 3, dedupKey: "b" }),
      state,
    );
    expect(suppressed.notification).toBeNull();
  });

  it("sends one resolved notification after recovery hysteresis", () => {
    const state = createAlertState();
    evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.3 }, { nowMinute: 1 }),
      state,
    );
    evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.3 }, { nowMinute: 2 }),
      state,
    );
    expect(
      evaluatePolicySample(
        basePolicy,
        sample({ sessions: 100, session_error_rate: 0.05 }, { nowMinute: 3 }),
        state,
      ).notification,
    ).toBeNull();
    const resolved = evaluatePolicySample(
      basePolicy,
      sample({ sessions: 100, session_error_rate: 0.05 }, { nowMinute: 4 }),
      state,
    );
    expect(resolved.notification).toEqual({ type: "resolved", dedupKey: "dedup" });
  });

  it("keeps NO_DATA and QUERY_ERROR distinct from healthy", () => {
    expect(evaluatePolicySample(basePolicy, { noData: true }).state.status).toBe(
      POLICY_STATUS.NO_DATA,
    );
    expect(evaluatePolicySample(basePolicy, { queryError: true }).state.status).toBe(
      POLICY_STATUS.QUERY_ERROR,
    );
  });

  it("does not breach on null values or unsupported threshold direction", () => {
    const state = createAlertState();
    expect(
      evaluatePolicySample(basePolicy, sample({ sessions: 100, session_error_rate: null }), state)
        .state.status,
    ).toBe(POLICY_STATUS.HEALTHY);
    expect(
      evaluatePolicySample(basePolicy, sample({ session_error_rate: 0.5 }), state).state.status,
    ).toBe(POLICY_STATUS.INSUFFICIENT_SAMPLE);
    expect(
      evaluatePolicySample(
        { ...basePolicy, threshold: { direction: "above", absoluteStarterValue: 0.2 } },
        sample({ sessions: 100, session_error_rate: 0.3 }),
        state,
      ).state.status,
    ).toBe(POLICY_STATUS.PENDING);
    expect(
      evaluatePolicySample(
        { ...basePolicy, threshold: { direction: "below", starterValue: 0.2 } },
        { row: { sessions: 100, session_error_rate: 0.3 } },
        state,
      ).state.status,
    ).toBe(POLICY_STATUS.HEALTHY);
  });


  it("handles telemetry freshness company window recovery", () => {
    const policy = {
      ...basePolicy,
      id: "telemetry-freshness",
      metricId: "last_observed_ingestion_age_rumdata",
      threshold: { direction: "above", starterValue: 30 },
      sample: { field: "last_event_us", minimum: 1 },
      recoveryCondition: {
        direction: "observed_within_company_window",
        value: "REQUIRED_COMPANY_DECISION",
        requiredConsecutiveHealthy: 1,
      },
    };
    const state = createAlertState();
    expect(evaluatePolicySample(policy, sample({ ageMinutes: 40 }), state).state.status).toBe(
      POLICY_STATUS.PENDING,
    );
    expect(
      evaluatePolicySample(policy, sample({ last_event_us: 1, ageMinutes: 40 }), state).notification
        ?.type,
    ).toBe("firing");
    expect(
      evaluatePolicySample(
        policy,
        sample({ last_event_us: 2, ageMinutes: 1, observedWithinCompanyWindow: true }),
        state,
      ).notification?.type,
    ).toBe("resolved");
  });
});

describe("normalizeAlertExport", () => {
  it("removes volatile ids and redacts destination material", () => {
    expect(
      normalizeAlertExport({
        id: "id",
        uuid: "uuid",
        alert_id: "alert",
        updated_at: 1,
        created_at: 1,
        last_triggered_at: 1,
        url: "http://example",
        headers: { Authorization: "secret", "Content-Type": "application/json" },
      }),
    ).toEqual({
      url: "[redacted-runtime-url]",
      headers: { Authorization: "[redacted]", "Content-Type": "application/json" },
    });
    expect(normalizeAlertExport({ name: "plain" })).toEqual({ name: "plain" });
  });
});
