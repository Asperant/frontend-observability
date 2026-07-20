import { describe, expect, it } from "vitest";

import {
  HARD_OR_INFORMATIONAL,
  computeRegressionPercent,
  diffBudgetBaselines,
  evaluateAllBudgets,
  evaluateBudget,
  isHardBudget,
} from "../../../../scripts/performance/lib/budget-evaluator.js";

function budget(overrides = {}) {
  return {
    metricId: "example.metric",
    component: "example",
    profile: "normal",
    unit: "ms",
    absoluteMaximum: 100,
    baselineValue: null,
    allowedRegressionPercent: 20,
    sampleCount: 10,
    warmup: 1,
    measurementWindow: "single-profile-run",
    hardOrInformational: HARD_OR_INFORMATIONAL.HARD,
    rationale: "test",
    ...overrides,
  };
}

describe("isHardBudget", () => {
  it("distinguishes hard from informational", () => {
    expect(isHardBudget(budget())).toBe(true);
    expect(isHardBudget(budget({ hardOrInformational: HARD_OR_INFORMATIONAL.INFORMATIONAL }))).toBe(
      false,
    );
  });
});

describe("computeRegressionPercent", () => {
  it("computes signed percent change from baseline", () => {
    expect(computeRegressionPercent(100, 120)).toBe(20);
    expect(computeRegressionPercent(100, 80)).toBe(-20);
  });

  it("returns null when there is no usable baseline", () => {
    expect(computeRegressionPercent(null, 100)).toBeNull();
    expect(computeRegressionPercent(undefined, 100)).toBeNull();
    expect(computeRegressionPercent(0, 100)).toBeNull();
  });
});

describe("evaluateBudget", () => {
  it("fails a non-finite measured value and still reports hardOrInformational", () => {
    const result = evaluateBudget(budget(), Number.NaN);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/not a finite number/);
    // Regression: a hard budget whose measurement is missing/non-finite must
    // still be classified as "hard" so evaluateAllBudgets' overallPass
    // gate actually fails on it, instead of silently falling through to the
    // informational branch because hardOrInformational was undefined.
    expect(result.hardOrInformational).toBe(HARD_OR_INFORMATIONAL.HARD);
  });

  it("passes when under the absolute maximum with no baseline", () => {
    const result = evaluateBudget(budget(), 50);
    expect(result.pass).toBe(true);
    expect(result.regressionPercent).toBeNull();
  });

  it("fails when over the absolute maximum", () => {
    const result = evaluateBudget(budget(), 150);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/exceeds absoluteMaximum/);
  });

  it("fails when within the absolute maximum but over the regression budget", () => {
    const result = evaluateBudget(budget({ baselineValue: 50 }), 65);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/exceeds allowedRegressionPercent/);
  });

  it("passes when within both the absolute maximum and the regression budget", () => {
    const result = evaluateBudget(budget({ baselineValue: 50 }), 55);
    expect(result.pass).toBe(true);
    expect(result.regressionPercent).toBe(10);
  });
});

describe("evaluateAllBudgets", () => {
  it("fails a metricId with no recorded measurement", () => {
    const { overallPass, results } = evaluateAllBudgets([budget()], {});
    expect(overallPass).toBe(false);
    expect(results[0].pass).toBe(false);
    expect(results[0].reason).toMatch(/no measurement was recorded/);
  });

  it("passes overall when every hard budget passes", () => {
    const { overallPass } = evaluateAllBudgets(
      [budget({ metricId: "a" }), budget({ metricId: "b" })],
      { a: 10, b: 20 },
    );
    expect(overallPass).toBe(true);
  });

  it("does not fail overall on an informational-budget failure", () => {
    const { overallPass, results } = evaluateAllBudgets(
      [
        budget({
          metricId: "info",
          hardOrInformational: HARD_OR_INFORMATIONAL.INFORMATIONAL,
          absoluteMaximum: 10,
        }),
      ],
      { info: 999 },
    );
    expect(results[0].pass).toBe(false);
    expect(overallPass).toBe(true);
  });

  it("fails overall on a hard-budget failure", () => {
    const { overallPass } = evaluateAllBudgets([budget({ absoluteMaximum: 10 })], {
      "example.metric": 999,
    });
    expect(overallPass).toBe(false);
  });
});

describe("diffBudgetBaselines", () => {
  it("reports added, removed, and modified budgets", () => {
    const oldBudgets = [
      budget({ metricId: "kept", baselineValue: null }),
      budget({ metricId: "gone" }),
    ];
    const newBudgets = [
      budget({ metricId: "kept", baselineValue: 42 }),
      budget({ metricId: "new" }),
    ];
    const diffs = diffBudgetBaselines(oldBudgets, newBudgets);
    const byId = Object.fromEntries(diffs.map((diff) => [diff.metricId, diff]));
    expect(byId.new.change).toBe("added");
    expect(byId.gone.change).toBe("removed");
    expect(byId.kept.change).toBe("modified");
    expect(byId.kept.fieldChanges).toEqual([{ field: "baselineValue", before: null, after: 42 }]);
  });

  it("reports no diff for identical budget sets", () => {
    const budgets = [budget()];
    expect(diffBudgetBaselines(budgets, budgets)).toEqual([]);
  });
});
