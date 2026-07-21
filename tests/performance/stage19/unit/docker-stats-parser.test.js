import { describe, expect, it } from "vitest";

import {
  DockerStatsParseError,
  parseByteSize,
  parseDockerStatsLine,
  parseDockerStatsSnapshot,
  parsePairedByteSize,
  parsePercent,
} from "../../../../scripts/performance/lib/docker-stats-parser.js";

describe("parseByteSize", () => {
  it("parses decimal units", () => {
    expect(parseByteSize("800B")).toBe(800);
    expect(parseByteSize("1.5kB")).toBe(1500);
    expect(parseByteSize("1e+03kB")).toBe(1_000_000);
    expect(parseByteSize("2MB")).toBe(2_000_000);
    expect(parseByteSize("1GB")).toBe(1_000_000_000);
    expect(parseByteSize("1TB")).toBe(1_000_000_000_000);
  });

  it("parses binary units case-sensitively on the i marker", () => {
    expect(parseByteSize("1.5MiB")).toBe(Math.round(1.5 * 1024 ** 2));
    expect(parseByteSize("1GiB")).toBe(1024 ** 3);
    expect(parseByteSize("1KiB")).toBe(1024);
    expect(parseByteSize("1TiB")).toBe(1024 ** 4);
  });

  it("rejects empty, malformed, non-numeric, and unrecognized-unit input", () => {
    expect(() => parseByteSize("")).toThrow(DockerStatsParseError);
    expect(() => parseByteSize("   ")).toThrow(DockerStatsParseError);
    expect(() => parseByteSize(undefined)).toThrow(DockerStatsParseError);
    expect(() => parseByteSize("not-a-size")).toThrow(DockerStatsParseError);
    expect(() => parseByteSize("nanXB")).toThrow(DockerStatsParseError);
    expect(() => parseByteSize("1e999B")).toThrow(DockerStatsParseError);
    expect(() => parseByteSize("5QQ")).toThrow(DockerStatsParseError);
    expect(() => parseByteSize("..XB")).toThrow(DockerStatsParseError);
  });

  it("carries the raw offending value on the error", () => {
    try {
      parseByteSize("bogus");
      throw new Error("expected parseByteSize to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DockerStatsParseError);
      expect(error.raw).toBe("bogus");
    }
  });
});

describe("parsePairedByteSize", () => {
  it("splits a used/total pair", () => {
    expect(parsePairedByteSize("1.5MiB / 200MiB")).toEqual({
      used: Math.round(1.5 * 1024 ** 2),
      total: 200 * 1024 ** 2,
    });
  });

  it("rejects input without a separator or non-string input", () => {
    expect(() => parsePairedByteSize("1MiB")).toThrow(DockerStatsParseError);
    expect(() => parsePairedByteSize(null)).toThrow(DockerStatsParseError);
  });
});

describe("parsePercent", () => {
  it("parses a percentage string", () => {
    expect(parsePercent("12.34%")).toBeCloseTo(12.34);
    expect(parsePercent("0.00%")).toBe(0);
  });

  it("rejects non-percent and non-numeric input", () => {
    expect(() => parsePercent("12.34")).toThrow(DockerStatsParseError);
    expect(() => parsePercent(null)).toThrow(DockerStatsParseError);
    expect(() => parsePercent("nan%")).toThrow(DockerStatsParseError);
  });
});

const validRawLine = JSON.stringify({
  Name: "chicek-lab-openobserve-1",
  CPUPerc: "1.23%",
  MemUsage: "512MiB / 3GiB",
  MemPerc: "16.67%",
  NetIO: "800B / 126B",
  BlockIO: "791kB / 0B",
  PIDs: "12",
});

describe("parseDockerStatsLine", () => {
  it("parses a well-formed line into a normalized snapshot", () => {
    expect(parseDockerStatsLine(validRawLine)).toEqual({
      name: "chicek-lab-openobserve-1",
      cpuPercent: 1.23,
      memUsageBytes: 512 * 1024 ** 2,
      memLimitBytes: 3 * 1024 ** 3,
      memPercent: 16.67,
      netRxBytes: 800,
      netTxBytes: 126,
      blockReadBytes: 791_000,
      blockWriteBytes: 0,
      pids: 12,
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseDockerStatsLine("{not json")).toThrow(DockerStatsParseError);
  });

  it("rejects non-object JSON", () => {
    expect(() => parseDockerStatsLine("42")).toThrow(DockerStatsParseError);
    expect(() => parseDockerStatsLine("null")).toThrow(DockerStatsParseError);
  });

  it("rejects a line missing a required field", () => {
    const missingField = JSON.stringify({
      Name: "x",
      CPUPerc: "1%",
      MemUsage: "1MiB / 2MiB",
      MemPerc: "1%",
      NetIO: "1B / 1B",
      BlockIO: "1B / 1B",
      // PIDs omitted
    });
    expect(() => parseDockerStatsLine(missingField)).toThrow(DockerStatsParseError);
  });
});

describe("parseDockerStatsSnapshot", () => {
  it("parses multiple NDJSON lines and skips blank lines", () => {
    const snapshot = parseDockerStatsSnapshot(`${validRawLine}\n\n${validRawLine}\n`);
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0].name).toBe("chicek-lab-openobserve-1");
  });

  it("returns an empty array for empty output", () => {
    expect(parseDockerStatsSnapshot("")).toEqual([]);
    expect(parseDockerStatsSnapshot("\n\n")).toEqual([]);
  });

  it("rejects non-string input", () => {
    expect(() => parseDockerStatsSnapshot(null)).toThrow(DockerStatsParseError);
  });
});
