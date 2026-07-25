// Pure aggregation over parsed docker-stats snapshots (see docker-stats-parser.js)
// plus optional file-descriptor counts. No process/network/filesystem I/O —
// scripts/performance/collect-container-metrics.mjs and run-resilience-soak.mjs
// own sampling and feed timestamped samples through this module.
// 100%-coverage-gated (see vitest.config.js's "scripts/performance/lib/**" entry).

export const TREND_CLASSIFICATION = Object.freeze({
  INSUFFICIENT_DATA: "insufficient-data",
  FLAT: "flat",
  GROWING: "growing",
  SHRINKING: "shrinking",
});

/** memUsageBytes / memLimitBytes, guarding against a zero/missing limit. */
export function computeMemoryLimitRatio(memUsageBytes, memLimitBytes) {
  if (!Number.isFinite(memLimitBytes) || memLimitBytes <= 0) {
    return null;
  }
  return memUsageBytes / memLimitBytes;
}

/**
 * A minimal least-squares slope over `{ timestampMs, value }` samples, per
 * sample index rather than per wall-clock ms (sampling interval is constant
 * by construction in the soak/benchmark runners), so the result is directly
 * comparable across runs regardless of sampling cadence.
 */
function leastSquaresSlope(values) {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = index - meanX;
    numerator += dx * (values[index] - meanY);
    denominator += dx * dx;
  }
  // n >= 3 is guaranteed by computeSeriesTrend's own guard before calling
  // this, and index spread alone (independent of sample values) makes
  // denominator > 0 whenever n >= 2 — never actually 0 here.
  return numerator / denominator;
}

/**
 * Classifies a series of samples (e.g. RSS bytes or FD counts over a soak
 * run) as flat/growing/shrinking, using the slope relative to the series'
 * own mean so the same relative threshold works across metrics of very
 * different absolute scale.
 */
export function computeSeriesTrend(samples, { relativeThreshold = 0.02 } = {}) {
  if (!Array.isArray(samples) || samples.length < 3) {
    return { classification: TREND_CLASSIFICATION.INSUFFICIENT_DATA, slopePerSample: null };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const slope = leastSquaresSlope(samples);
  if (mean === 0) {
    return {
      classification: slope === 0 ? TREND_CLASSIFICATION.FLAT : TREND_CLASSIFICATION.GROWING,
      slopePerSample: slope,
    };
  }
  const relativeSlope = slope / Math.abs(mean);
  if (relativeSlope > relativeThreshold) {
    return { classification: TREND_CLASSIFICATION.GROWING, slopePerSample: slope };
  }
  if (relativeSlope < -relativeThreshold) {
    return { classification: TREND_CLASSIFICATION.SHRINKING, slopePerSample: slope };
  }
  return { classification: TREND_CLASSIFICATION.FLAT, slopePerSample: slope };
}

/**
 * `samples` is an array of parsed docker-stats snapshots (docker-stats-parser.js
 * output) for one single container, taken over time. Returns peak/aggregate
 * values plus trend classifications used for the leak-detection hard gate.
 */
export function aggregateContainerSeries(samples, { memoryLimitBytes } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("aggregateContainerSeries requires at least one sample");
  }
  const cpuValues = samples.map((sample) => sample.cpuPercent);
  const memValues = samples.map((sample) => sample.memUsageBytes);
  const pidValues = samples.map((sample) => sample.pids);
  const limit = memoryLimitBytes ?? samples[0].memLimitBytes;
  const ratios = samples
    .map((sample) => computeMemoryLimitRatio(sample.memUsageBytes, limit))
    .filter((ratio) => ratio !== null);

  return {
    sampleCount: samples.length,
    peakCpuPercent: Math.max(...cpuValues),
    peakMemUsageBytes: Math.max(...memValues),
    peakMemLimitRatio: ratios.length > 0 ? Math.max(...ratios) : null,
    peakPids: Math.max(...pidValues),
    netRxTotalBytes: samples[samples.length - 1].netRxBytes - samples[0].netRxBytes,
    netTxTotalBytes: samples[samples.length - 1].netTxBytes - samples[0].netTxBytes,
    memoryTrend: computeSeriesTrend(memValues),
    pidTrend: computeSeriesTrend(pidValues),
  };
}

/**
 * `beforeCount`/`afterCount` are open-file-descriptor counts (e.g. from
 * `/proc/<pid>/fd` entries inside the container) taken before a load and
 * after its recovery/settle window. Positive delta means growth.
 */
export function computeFdDelta(beforeCount, afterCount) {
  if (!Number.isFinite(beforeCount) || !Number.isFinite(afterCount)) {
    throw new Error("computeFdDelta requires finite before/after counts");
  }
  return afterCount - beforeCount;
}

/**
 * Runs computeSeriesTrend across successive load→recovery cycles' peak
 * values (at least 3, per resilience Section 14) to flag a persistent
 * monotonic climb across cycles, distinct from within-cycle noise.
 */
export function detectCrossCycleLeak(cyclePeakValues, options) {
  const trend = computeSeriesTrend(cyclePeakValues, options);
  return {
    ...trend,
    isLeak: trend.classification === TREND_CLASSIFICATION.GROWING,
  };
}
