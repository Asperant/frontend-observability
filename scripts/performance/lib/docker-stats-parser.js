// Pure parsing for `docker stats --no-stream --format '{{json .}}'` output.
// No process/network/filesystem I/O here — scripts/performance/collect-container-metrics.mjs
// owns spawning docker and feeds its raw stdout through this module.
// 100%-coverage-gated (see vitest.config.js's "scripts/performance/lib/**" entry).

const BYTE_UNITS = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

export class DockerStatsParseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = "DockerStatsParseError";
    this.raw = raw;
  }
}

/**
 * Parses a single Docker byte-size string, e.g. "1.5MiB", "800B", "12kB", "1e+03kB".
 * Docker's own formatter always emits a single number+unit token (no
 * spaces inside the token), case-sensitive for the "i" (binary) marker.
 */
export function parseByteSize(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new DockerStatsParseError(`empty byte-size value`, text);
  }
  const match = text.trim().match(/^((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([A-Za-z]+)$/i);
  if (!match) {
    throw new DockerStatsParseError(`unrecognized byte-size format: "${text}"`, text);
  }
  const [, numberText, unitText] = match;
  const value = Number.parseFloat(numberText);
  if (!Number.isFinite(value)) {
    throw new DockerStatsParseError(`non-numeric byte-size value: "${text}"`, text);
  }
  const unitKey = unitText.toLowerCase();
  const multiplier = BYTE_UNITS[unitKey];
  if (multiplier === undefined) {
    throw new DockerStatsParseError(`unrecognized byte-size unit: "${unitText}"`, text);
  }
  return Math.round(value * multiplier);
}

/** Parses Docker's "1.5MiB / 200MiB" style paired field (mem usage/limit, net I/O, block I/O). */
export function parsePairedByteSize(text) {
  if (typeof text !== "string" || !text.includes("/")) {
    throw new DockerStatsParseError(`expected "<used> / <total>" pair, got: "${text}"`, text);
  }
  const [usedText, totalText] = text.split("/").map((part) => part.trim());
  return { used: parseByteSize(usedText), total: parseByteSize(totalText) };
}

/** Parses a Docker percentage string, e.g. "12.34%". */
export function parsePercent(text) {
  if (typeof text !== "string" || !text.trim().endsWith("%")) {
    throw new DockerStatsParseError(`expected a "%"-suffixed value, got: "${text}"`, text);
  }
  const value = Number.parseFloat(text.trim().slice(0, -1));
  if (!Number.isFinite(value)) {
    throw new DockerStatsParseError(`non-numeric percentage value: "${text}"`, text);
  }
  return value;
}

/** Parses one `docker stats --format '{{json .}}'` NDJSON line into a normalized snapshot. */
export function parseDockerStatsLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new DockerStatsParseError(`invalid JSON line: ${error.message}`, line);
  }
  if (!raw || typeof raw !== "object") {
    throw new DockerStatsParseError("stats line did not parse to an object", line);
  }
  const requiredKeys = ["Name", "CPUPerc", "MemUsage", "MemPerc", "NetIO", "BlockIO", "PIDs"];
  for (const key of requiredKeys) {
    if (!(key in raw)) {
      throw new DockerStatsParseError(`stats line missing required field "${key}"`, line);
    }
  }
  const mem = parsePairedByteSize(raw.MemUsage);
  const net = parsePairedByteSize(raw.NetIO);
  const block = parsePairedByteSize(raw.BlockIO);
  return {
    name: raw.Name,
    cpuPercent: parsePercent(raw.CPUPerc),
    memUsageBytes: mem.used,
    memLimitBytes: mem.total,
    memPercent: parsePercent(raw.MemPerc),
    netRxBytes: net.used,
    netTxBytes: net.total,
    blockReadBytes: block.used,
    blockWriteBytes: block.total,
    pids: Number.parseInt(raw.PIDs, 10),
  };
}

/**
 * Parses the full NDJSON output of `docker stats --no-stream --format '{{json .}}'`
 * (one JSON object per line, one line per container). Blank lines are skipped;
 * every non-blank line must parse or the whole snapshot is rejected — a
 * partially-parsed resource snapshot is worse than a loud failure.
 */
export function parseDockerStatsSnapshot(rawOutput) {
  if (typeof rawOutput !== "string") {
    throw new DockerStatsParseError("docker stats output must be a string", rawOutput);
  }
  const lines = rawOutput.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => parseDockerStatsLine(line));
}
