import { describe, expect, it } from "vitest";

import {
  classifyRecovery,
  computeRecoveryTimings,
  detectStateDrift,
  verifyRestartCountExpectation,
} from "../../../../scripts/performance/lib/recovery-matrix.js";

describe("computeRecoveryTimings", () => {
  it("requires restartIssuedAtMs and becameHealthyAtMs", () => {
    expect(() => computeRecoveryTimings({})).toThrow();
    expect(() => computeRecoveryTimings({ restartIssuedAtMs: 0 })).toThrow();
  });

  it("computes full timings when every optional field is present", () => {
    const timings = computeRecoveryTimings({
      restartIssuedAtMs: 1000,
      becameUnhealthyAtMs: 1050,
      becameHealthyAtMs: 3000,
      firstSuccessfulIngestAtMs: 3200,
      firstSuccessfulQueryAtMs: 3500,
      firstSuccessfulNotificationAtMs: 4000,
    });
    expect(timings).toEqual({
      detectionTimeMs: 50,
      unreadyDurationMs: 1950,
      recoveryTimeMs: 2000,
      ingestRecoveryMs: 200,
      queryRecoveryMs: 500,
      notificationRecoveryMs: 1000,
    });
  });

  it("treats a missing becameUnhealthyAtMs as null detection/unready timing", () => {
    const timings = computeRecoveryTimings({
      restartIssuedAtMs: 1000,
      becameHealthyAtMs: 2000,
      firstSuccessfulIngestAtMs: null,
      firstSuccessfulQueryAtMs: null,
      firstSuccessfulNotificationAtMs: null,
    });
    expect(timings.detectionTimeMs).toBeNull();
    expect(timings.unreadyDurationMs).toBeNull();
    expect(timings.recoveryTimeMs).toBe(1000);
    expect(timings.ingestRecoveryMs).toBeNull();
    expect(timings.queryRecoveryMs).toBeNull();
    expect(timings.notificationRecoveryMs).toBeNull();
  });
});

describe("classifyRecovery", () => {
  const timings = { recoveryTimeMs: 5000, ingestRecoveryMs: null, queryRecoveryMs: 200 };

  it("skips thresholds whose timing value is null", () => {
    const result = classifyRecovery(timings, { ingestRecoveryMs: 1000 });
    expect(result.overallPass).toBe(true);
    expect(result.results[0].skipped).toBe(true);
  });

  it("passes when every measured timing is within its threshold", () => {
    const result = classifyRecovery(timings, { recoveryTimeMs: 10000, queryRecoveryMs: 1000 });
    expect(result.overallPass).toBe(true);
  });

  it("fails when a measured timing exceeds its threshold", () => {
    const result = classifyRecovery(timings, { recoveryTimeMs: 100 });
    expect(result.overallPass).toBe(false);
    expect(result.results[0].pass).toBe(false);
  });
});

describe("detectStateDrift", () => {
  it("reports no drift for identical snapshots", () => {
    const snapshot = { streams: 2, alerts: 6 };
    expect(detectStateDrift(snapshot, { ...snapshot })).toEqual({ hasDrift: false, drifted: [] });
  });

  it("reports every drifted key, including keys only present on one side", () => {
    const result = detectStateDrift(
      { alerts: 6, dashboards: 4 },
      { alerts: 5, dashboards: 4, extra: 1 },
    );
    expect(result.hasDrift).toBe(true);
    const byKey = Object.fromEntries(result.drifted.map((entry) => [entry.key, entry]));
    expect(byKey.alerts).toEqual({ key: "alerts", before: 6, after: 5 });
    expect(byKey.extra).toEqual({ key: "extra", before: undefined, after: 1 });
  });
});

describe("verifyRestartCountExpectation", () => {
  it("passes when only the target's restart count increased by exactly 1", () => {
    const result = verifyRestartCountExpectation(
      "openobserve",
      { openobserve: 2, "alert-sink": 1, "reverse-proxy": 0 },
      { openobserve: 3, "alert-sink": 1, "reverse-proxy": 0 },
    );
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails when the target's restart count did not increase by exactly 1", () => {
    const result = verifyRestartCountExpectation(
      "openobserve",
      { openobserve: 2 },
      { openobserve: 2 },
    );
    expect(result.pass).toBe(false);
    expect(result.violations[0]).toMatchObject({
      service: "openobserve",
      expectedDelta: 1,
      actualDelta: 0,
    });
  });

  it("fails when a non-target, non-allowed service restarted as a side effect", () => {
    const result = verifyRestartCountExpectation(
      "openobserve",
      { openobserve: 0, "reverse-proxy": 0 },
      { openobserve: 1, "reverse-proxy": 1 },
    );
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual({
      service: "reverse-proxy",
      expectedDelta: 0,
      actualDelta: 1,
    });
  });

  it("allows a named side-effect service to restart 0 or 1 times", () => {
    const allowed = ["alert-sink"];
    const restarted = verifyRestartCountExpectation(
      "openobserve",
      { openobserve: 0, "alert-sink": 0 },
      { openobserve: 1, "alert-sink": 1 },
      allowed,
    );
    expect(restarted.pass).toBe(true);

    const notRestarted = verifyRestartCountExpectation(
      "openobserve",
      { openobserve: 0, "alert-sink": 0 },
      { openobserve: 1, "alert-sink": 0 },
      allowed,
    );
    expect(notRestarted.pass).toBe(true);
  });

  it("flags a named side-effect service restarting more than once", () => {
    const result = verifyRestartCountExpectation(
      "openobserve",
      { openobserve: 0, "alert-sink": 0 },
      { openobserve: 1, "alert-sink": 2 },
      ["alert-sink"],
    );
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual({
      service: "alert-sink",
      expectedDelta: "0 or 1 (allowed side effect)",
      actualDelta: 2,
    });
  });

  it("treats a missing before-count as 0", () => {
    const result = verifyRestartCountExpectation("openobserve", {}, { openobserve: 1 });
    expect(result.pass).toBe(true);
  });
});
