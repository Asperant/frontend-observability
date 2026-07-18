import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  validateCustomAction,
  validateDiagnosticEvent,
  validateRuntimeConfig,
} from "../../packages/contracts/src/validators.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

function listFixtures(subdir) {
  return readdirSync(`${fixturesRoot}${subdir}`).map((name) => ({
    name,
    data: JSON.parse(readFileSync(`${fixturesRoot}${subdir}/${name}`, "utf8")),
  }));
}

describe.each([
  ["runtime-config", validateRuntimeConfig],
  ["custom-action", validateCustomAction],
  ["diagnostic-event", validateDiagnosticEvent],
])("%s fixtures conform to their contract", (subdir, validate) => {
  const fixtures = listFixtures(subdir);

  it("provides at least one valid and one invalid fixture", () => {
    expect(fixtures.some((fixture) => fixture.name.startsWith("valid"))).toBe(true);
    expect(fixtures.some((fixture) => fixture.name.startsWith("invalid-"))).toBe(true);
  });

  const validNames = fixtures
    .filter((fixture) => fixture.name.startsWith("valid"))
    .map((f) => f.name);
  const invalidNames = fixtures
    .filter((fixture) => fixture.name.startsWith("invalid-"))
    .map((f) => f.name);

  it.each(validNames)("%s passes schema validation", (name) => {
    const fixture = fixtures.find((f) => f.name === name);
    const result = validate(fixture.data);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it.each(invalidNames)("%s is rejected by schema validation", (name) => {
    const fixture = fixtures.find((f) => f.name === name);
    expect(validate(fixture.data).valid).toBe(false);
  });
});
