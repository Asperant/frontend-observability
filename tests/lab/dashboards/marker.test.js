import { describe, expect, it } from "vitest";

import {
  buildMarker,
  embedMarker,
  parseMarker,
  stripMarker,
} from "../../../scripts/lab/dashboards/marker.js";

describe("buildMarker", () => {
  it("builds a marker string for a valid starterId/version", () => {
    expect(buildMarker("frontend-operations", 1)).toBe("[chicek:starter:frontend-operations:v1]");
  });

  it("throws for an invalid starterId", () => {
    expect(() => buildMarker("Frontend Operations", 1)).toThrow(/invalid starterId/);
  });

  it("throws for a non-string starterId", () => {
    expect(() => buildMarker(null, 1)).toThrow(/invalid starterId/);
  });

  it("throws for a non-integer version", () => {
    expect(() => buildMarker("frontend-operations", 1.5)).toThrow(/invalid starterVersion/);
  });

  it("throws for a version below 1", () => {
    expect(() => buildMarker("frontend-operations", 0)).toThrow(/invalid starterVersion/);
  });
});

describe("parseMarker", () => {
  it("parses a valid marker out of a description", () => {
    expect(parseMarker("some text [chicek:starter:error-analysis:v2] more text")).toEqual({
      starterId: "error-analysis",
      starterVersion: 2,
    });
  });

  it("returns null when no marker is present", () => {
    expect(parseMarker("just a normal description")).toBeNull();
  });

  it("returns null for a non-string input", () => {
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker(undefined)).toBeNull();
  });
});

describe("stripMarker", () => {
  it("removes the marker and trims surrounding whitespace", () => {
    expect(stripMarker("hello [chicek:starter:x:v1]")).toBe("hello");
  });

  it("returns an empty string for a non-string input", () => {
    expect(stripMarker(null)).toBe("");
  });

  it("returns the text unchanged when no marker is present", () => {
    expect(stripMarker("plain text")).toBe("plain text");
  });
});

describe("embedMarker", () => {
  it("appends a marker to non-empty base text", () => {
    expect(embedMarker("Some description.", "frontend-operations", 1)).toBe(
      "Some description. [chicek:starter:frontend-operations:v1]",
    );
  });

  it("produces just the marker when the base description is empty", () => {
    expect(embedMarker("", "frontend-operations", 1)).toBe(
      "[chicek:starter:frontend-operations:v1]",
    );
  });

  it("replaces an existing marker rather than duplicating it", () => {
    const first = embedMarker("desc", "frontend-operations", 1);
    const second = embedMarker(first, "frontend-operations", 2);
    expect(second).toBe("desc [chicek:starter:frontend-operations:v2]");
  });

  it("defaults a null/undefined description to just the marker", () => {
    expect(embedMarker(undefined, "frontend-operations", 1)).toBe(
      "[chicek:starter:frontend-operations:v1]",
    );
  });
});
