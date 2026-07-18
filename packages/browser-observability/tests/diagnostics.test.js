import { beforeEach, describe, expect, it } from "vitest";

import { getDiagnostics, recordDiagnostic } from "../src/diagnostics/record-diagnostic.js";
import { resetState } from "../src/internal/state.js";

beforeEach(() => {
  resetState();
});

describe("recordDiagnostic", () => {
  it("stores a well-formed entry", () => {
    recordDiagnostic("info", "test.code", "hello", { a: 1 });
    const [entry] = getDiagnostics();
    expect(entry.level).toBe("info");
    expect(entry.code).toBe("test.code");
    expect(entry.message).toBe("hello");
    expect(entry.context).toEqual({ a: 1 });
    expect(entry.schemaVersion).toBe("1.0.0");
    expect(entry.timestamp).toEqual(expect.any(String));
  });

  it("falls back to 'info' for an unknown level", () => {
    recordDiagnostic("critical", "test.code", "hello");
    expect(getDiagnostics()[0].level).toBe("info");
  });

  it("falls back to a default code when code is missing or empty", () => {
    recordDiagnostic("info", "", "hello");
    expect(getDiagnostics()[0].code).toBe("diagnostic.unknown");
  });

  it("coerces a non-string message to an empty string", () => {
    recordDiagnostic("info", "test.code", 42);
    expect(getDiagnostics()[0].message).toBe("");
  });

  it("truncates an oversized message", () => {
    recordDiagnostic("info", "test.code", "x".repeat(1000));
    expect(getDiagnostics()[0].message.length).toBe(512);
  });

  it("omits context when it is not a plain object", () => {
    recordDiagnostic("info", "test.code", "hello", "not-an-object");
    expect(getDiagnostics()[0].context).toBeUndefined();
  });

  it("caps the ring buffer at MAX_DIAGNOSTICS and drops the oldest entry", () => {
    for (let i = 0; i < 60; i += 1) {
      recordDiagnostic("info", `code.${i}`, `message ${i}`);
    }
    const entries = getDiagnostics();
    expect(entries).toHaveLength(50);
    expect(entries[0].code).toBe("code.10");
    expect(entries.at(-1).code).toBe("code.59");
  });

  it("getDiagnostics returns a copy that cannot mutate internal state", () => {
    recordDiagnostic("info", "test.code", "hello");
    const entries = getDiagnostics();
    entries.push({ fake: true });
    expect(getDiagnostics()).toHaveLength(1);
  });
});
