import { describe, expect, it } from "vitest";

import {
  TREND_CLASSIFICATION,
  aggregateContainerSeries,
  computeFdDelta,
  computeMemoryLimitRatio,
  computeSeriesTrend,
  detectCrossCycleLeak,
} from "../../../../scripts/performance/lib/metrics-collector.js";

describe("computeMemoryLimitRatio", () => {
  it("computes usage/limit", () => {
    expect(computeMemoryLimitRatio(50, 100)).toBe(0.5);
  });

  it("returns null for a missing or non-positive limit", () => {
    expect(computeMemoryLimitRatio(50, 0)).toBeNull();
    expect(computeMemoryLimitRatio(50, -1)).toBeNull();
    expect(computeMemoryLimitRatio(50, undefined)).toBeNull();
    expect(computeMemoryLimitRatio(50, Number.NaN)).toBeNull();
  });
});

describe("computeSeriesTrend", () => {
  it("reports insufficient-data under 3 samples", () => {
    expect(computeSeriesTrend([]).classification).toBe(TREND_CLASSIFICATION.INSUFFICIENT_DATA);
    expect(computeSeriesTrend([1, 2]).classification).toBe(TREND_CLASSIFICATION.INSUFFICIENT_DATA);
    expect(computeSeriesTrend(null).classification).toBe(TREND_CLASSIFICATION.INSUFFICIENT_DATA);
  });

  it("classifies a flat series", () => {
    expect(computeSeriesTrend([100, 100, 100, 100]).classification).toBe(TREND_CLASSIFICATION.FLAT);
  });

  it("classifies a growing series", () => {
    const result = computeSeriesTrend([100, 120, 140, 160, 180]);
    expect(result.classification).toBe(TREND_CLASSIFICATION.GROWING);
    expect(result.slopePerSample).toBeGreaterThan(0);
  });

  it("classifies a shrinking series", () => {
    const result = computeSeriesTrend([180, 160, 140, 120, 100]);
    expect(result.classification).toBe(TREND_CLASSIFICATION.SHRINKING);
    expect(result.slopePerSample).toBeLessThan(0);
  });

  it("handles a zero-mean flat series without dividing by zero", () => {
    expect(computeSeriesTrend([0, 0, 0]).classification).toBe(TREND_CLASSIFICATION.FLAT);
  });

  it("handles a zero-mean series with nonzero slope", () => {
    // mean([-1, 0, 1]) === 0 but the series is still monotonically increasing.
    expect(computeSeriesTrend([-1, 0, 1]).classification).toBe(TREND_CLASSIFICATION.GROWING);
  });

  it("honors a custom relative threshold", () => {
    const noisyFlat = [100, 101, 99, 100, 101];
    expect(computeSeriesTrend(noisyFlat, { relativeThreshold: 0.5 }).classification).toBe(
      TREND_CLASSIFICATION.FLAT,
    );
  });
});

function sample(overrides = {}) {
  return {
    name: "svc",
    cpuPercent: 1,
    memUsageBytes: 100,
    memLimitBytes: 1000,
    memPercent: 10,
    netRxBytes: 0,
    netTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    pids: 5,
    ...overrides,
  };
}

describe("aggregateContainerSeries", () => {
  it("throws on empty input", () => {
    expect(() => aggregateContainerSeries([])).toThrow();
    expect(() => aggregateContainerSeries(null)).toThrow();
  });

  it("aggregates peaks, net totals, and trends across samples", () => {
    const samples = [
      sample({ cpuPercent: 1, memUsageBytes: 100, pids: 5, netRxBytes: 0, netTxBytes: 0 }),
      sample({ cpuPercent: 3, memUsageBytes: 150, pids: 6, netRxBytes: 500, netTxBytes: 200 }),
      sample({ cpuPercent: 2, memUsageBytes: 200, pids: 7, netRxBytes: 900, netTxBytes: 400 }),
    ];
    const result = aggregateContainerSeries(samples);
    expect(result.sampleCount).toBe(3);
    expect(result.peakCpuPercent).toBe(3);
    expect(result.peakMemUsageBytes).toBe(200);
    expect(result.peakMemLimitRatio).toBeCloseTo(0.2);
    expect(result.peakPids).toBe(7);
    expect(result.netRxTotalBytes).toBe(900);
    expect(result.netTxTotalBytes).toBe(400);
    expect(result.memoryTrend.classification).toBe(TREND_CLASSIFICATION.GROWING);
    expect(result.pidTrend.classification).toBe(TREND_CLASSIFICATION.GROWING);
  });

  it("accepts an explicit memoryLimitBytes override", () => {
    const samples = [
      sample({ memUsageBytes: 50 }),
      sample({ memUsageBytes: 50 }),
      sample({ memUsageBytes: 50 }),
    ];
    const result = aggregateContainerSeries(samples, { memoryLimitBytes: 500 });
    expect(result.peakMemLimitRatio).toBeCloseTo(0.1);
  });

  it("returns a null peakMemLimitRatio when no sample has a usable limit", () => {
    const samples = [
      sample({ memLimitBytes: 0 }),
      sample({ memLimitBytes: 0 }),
      sample({ memLimitBytes: 0 }),
    ];
    const result = aggregateContainerSeries(samples, { memoryLimitBytes: 0 });
    expect(result.peakMemLimitRatio).toBeNull();
  });
});

describe("computeFdDelta", () => {
  it("computes the signed delta", () => {
    expect(computeFdDelta(10, 15)).toBe(5);
    expect(computeFdDelta(15, 10)).toBe(-5);
  });

  it("rejects non-finite input", () => {
    expect(() => computeFdDelta(Number.NaN, 10)).toThrow();
    expect(() => computeFdDelta(10, undefined)).toThrow();
  });
});

describe("detectCrossCycleLeak", () => {
  it("flags a growing cross-cycle peak series as a leak", () => {
    const result = detectCrossCycleLeak([100, 130, 170]);
    expect(result.isLeak).toBe(true);
    expect(result.classification).toBe(TREND_CLASSIFICATION.GROWING);
  });

  it("does not flag a flat cross-cycle peak series as a leak", () => {
    const result = detectCrossCycleLeak([100, 102, 99]);
    expect(result.isLeak).toBe(false);
  });
});
