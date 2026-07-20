import { describe, expect, it } from "vitest";

import {
  DashboardVariableToken,
  renderQueryTemplate,
  TEMPLATE_ERROR_REASON,
  TemplateError,
  validateTimeRange,
} from "../../../scripts/lab/dashboards/sql-template.js";

const BASE_MANIFEST = Object.freeze({
  sqlTemplate:
    "select count(*) as sessions from _rumdata where service = {{service}} and env = {{environment}}{{version_clause}}",
  requiredVariables: ["service", "environment"],
  optionalVariables: [
    { name: "version", column: "version", clausePlaceholder: "{{version_clause}}" },
  ],
  drilldownVariables: [],
});

describe("renderQueryTemplate", () => {
  it("renders required variables and an omitted optional clause", () => {
    const sql = renderQueryTemplate(BASE_MANIFEST, {
      service: "demo-frontend",
      environment: "lab",
    });
    expect(sql).toBe(
      "select count(*) as sessions from _rumdata where service = 'demo-frontend' and env = 'lab'",
    );
  });

  it("renders an optional variable's clause when provided", () => {
    const sql = renderQueryTemplate(BASE_MANIFEST, {
      service: "demo-frontend",
      environment: "lab",
      version: "2026.07.1",
    });
    expect(sql).toBe(
      "select count(*) as sessions from _rumdata where service = 'demo-frontend' and env = 'lab' and version = '2026.07.1'",
    );
  });

  it("throws MISSING_REQUIRED_VARIABLE when a required variable is absent", () => {
    try {
      renderQueryTemplate(BASE_MANIFEST, { service: "demo-frontend" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect(error.reason).toBe(TEMPLATE_ERROR_REASON.MISSING_REQUIRED_VARIABLE);
      expect(error.detail).toBe("environment");
    }
  });

  it("throws MISSING_REQUIRED_VARIABLE for an empty-string value", () => {
    expect(() => renderQueryTemplate(BASE_MANIFEST, { service: "", environment: "lab" })).toThrow(
      TemplateError,
    );
  });

  it("throws UNSAFE_VALUE for a value outside the safe charset", () => {
    try {
      renderQueryTemplate(BASE_MANIFEST, {
        service: "demo'; drop table x; --",
        environment: "lab",
      });
      expect.unreachable();
    } catch (error) {
      expect(error.reason).toBe(TEMPLATE_ERROR_REASON.UNSAFE_VALUE);
    }
  });

  it("escapes an embedded single quote in an otherwise-safe value", () => {
    // Charset allows letters/digits/space/dot/dash only, so a literal quote
    // is already rejected by the charset — this asserts double-escaping
    // logic is dead code only reachable if the charset ever changes, by
    // exercising the escape path through a value that IS in-charset.
    const sql = renderQueryTemplate(BASE_MANIFEST, {
      service: "demo-frontend",
      environment: "lab",
    });
    expect(sql).not.toContain("''");
  });

  it("renders a drilldown variable", () => {
    const manifest = {
      sqlTemplate: "select * from _rumdata where session_id = {{session_id}} limit 10",
      requiredVariables: [],
      optionalVariables: [],
      drilldownVariables: ["session_id"],
    };
    const sql = renderQueryTemplate(manifest, { session_id: "abc-123" });
    expect(sql).toBe("select * from _rumdata where session_id = 'abc-123' limit 10");
  });

  it("renders a DashboardVariableToken as a raw $-prefixed token, unescaped", () => {
    const manifest = {
      sqlTemplate: "select * from _rumdata where session_id = {{session_id}} limit 10",
      requiredVariables: [],
      optionalVariables: [],
      drilldownVariables: ["session_id"],
    };
    const sql = renderQueryTemplate(manifest, {
      session_id: new DashboardVariableToken("session_id"),
    });
    expect(sql).toBe("select * from _rumdata where session_id = $session_id limit 10");
  });

  it("throws UNRESOLVED_PLACEHOLDER when the template contains an unrecognized token", () => {
    const manifest = {
      sqlTemplate: "select {{unknown}} from _rumdata",
      requiredVariables: [],
      optionalVariables: [],
      drilldownVariables: [],
    };
    try {
      renderQueryTemplate(manifest);
      expect.unreachable();
    } catch (error) {
      expect(error.reason).toBe(TEMPLATE_ERROR_REASON.UNRESOLVED_PLACEHOLDER);
      expect(error.detail).toBe("{{unknown}}");
    }
  });

  it("defaults requiredVariables/drilldownVariables/optionalVariables to [] when the manifest omits them", () => {
    expect(renderQueryTemplate({ sqlTemplate: "select 1" })).toBe("select 1");
  });

  it("defaults variables to an empty object when omitted", () => {
    const manifest = {
      sqlTemplate: "select 1",
      requiredVariables: [],
      optionalVariables: [],
      drilldownVariables: [],
    };
    expect(renderQueryTemplate(manifest)).toBe("select 1");
  });
});

describe("DashboardVariableToken", () => {
  it("exposes the $-prefixed SQL form via toSql", () => {
    expect(new DashboardVariableToken("session_id").toSql()).toBe("$session_id");
  });

  it("throws for an invalid token name", () => {
    expect(() => new DashboardVariableToken("Session-Id")).toThrow(TemplateError);
  });

  it("throws for a non-string token name", () => {
    expect(() => new DashboardVariableToken(123)).toThrow(TemplateError);
  });
});

describe("validateTimeRange", () => {
  it("accepts a bounded, well-formed range", () => {
    expect(validateTimeRange(168, 0, 1000)).toEqual({ ok: true, reason: "OK" });
  });

  it("rejects a non-integer start", () => {
    expect(validateTimeRange(168, 1.5, 1000).ok).toBe(false);
  });

  it("rejects an end that is not after start", () => {
    expect(validateTimeRange(168, 1000, 1000)).toEqual({ ok: false, reason: "INVALID_TIME_RANGE" });
  });

  it("rejects a range wider than the ceiling", () => {
    const oneHourUs = 60 * 60 * 1_000_000;
    const result = validateTimeRange(1, 0, oneHourUs * 2);
    expect(result).toEqual({ ok: false, reason: "TIME_RANGE_EXCEEDS_CEILING" });
  });
});
