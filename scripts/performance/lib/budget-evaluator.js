// Pure evaluation of measured values against infrastructure/performance/resilience-performance-budgets.json
// budget definitions. No file I/O here — callers read the JSON file and pass
// the parsed `budgets` array in. 100%-coverage-gated (see vitest.config.js's
// "scripts/performance/lib/**" entry).

export const HARD_OR_INFORMATIONAL = Object.freeze({
  HARD: "hard",
  INFORMATIONAL: "informational",
});

export function isHardBudget(budgetDef) {
  return budgetDef.hardOrInformational === HARD_OR_INFORMATIONAL.HARD;
}

/** (measured - baseline) / baseline * 100, signed; null when there is no baseline yet. */
export function computeRegressionPercent(baselineValue, measuredValue) {
  if (baselineValue === null || baselineValue === undefined || baselineValue === 0) {
    return null;
  }
  return ((measuredValue - baselineValue) / baselineValue) * 100;
}

/**
 * Evaluates one measured value against one budget definition. Two
 * independent gates: the absolute ceiling always applies; the
 * regression-vs-baseline gate only applies once a baseline has been set by
 * an explicit operator edit (see the budgets file's own description field).
 */
export function evaluateBudget(budgetDef, measuredValue) {
  if (!Number.isFinite(measuredValue)) {
    return {
      metricId: budgetDef.metricId,
      pass: false,
      reason: "measured value is not a finite number",
      measuredValue,
      hardOrInformational: budgetDef.hardOrInformational,
    };
  }

  const exceedsAbsoluteMaximum = measuredValue > budgetDef.absoluteMaximum;
  const regressionPercent = computeRegressionPercent(budgetDef.baselineValue, measuredValue);
  const exceedsRegressionBudget =
    regressionPercent !== null && regressionPercent > budgetDef.allowedRegressionPercent;

  const pass = !exceedsAbsoluteMaximum && !exceedsRegressionBudget;
  let reason = "within absolute maximum and regression budget";
  if (exceedsAbsoluteMaximum) {
    reason = `measured ${measuredValue} exceeds absoluteMaximum ${budgetDef.absoluteMaximum}`;
  } else if (exceedsRegressionBudget) {
    reason = `regression ${regressionPercent.toFixed(2)}% exceeds allowedRegressionPercent ${budgetDef.allowedRegressionPercent}%`;
  }

  return {
    metricId: budgetDef.metricId,
    pass,
    reason,
    measuredValue,
    absoluteMaximum: budgetDef.absoluteMaximum,
    baselineValue: budgetDef.baselineValue,
    regressionPercent,
    hardOrInformational: budgetDef.hardOrInformational,
  };
}

/**
 * Evaluates every measurement against its matching budget by metricId.
 * `measurements` is a `{ [metricId]: number }` map. A metricId present in
 * `budgets` but missing from `measurements` is itself a failure — a budget
 * that was never measured cannot be reported as passing. `overallPass` only
 * counts hard budgets; informational-budget failures are reported but never
 * fail the gate.
 */
export function evaluateAllBudgets(budgets, measurements) {
  const results = budgets.map((budgetDef) => {
    if (!(budgetDef.metricId in measurements)) {
      return {
        metricId: budgetDef.metricId,
        pass: false,
        reason: "no measurement was recorded for this metricId",
        measuredValue: null,
        hardOrInformational: budgetDef.hardOrInformational,
      };
    }
    return evaluateBudget(budgetDef, measurements[budgetDef.metricId]);
  });

  const overallPass = results.every(
    (result) => result.pass || result.hardOrInformational === HARD_OR_INFORMATIONAL.INFORMATIONAL,
  );

  return { overallPass, results };
}

/**
 * Diffs two budget-file `budgets` arrays (old vs. new) by metricId, listing
 * every field that changed. Used to make any operator edit to baselineValue
 * (or anything else in the budgets file) visible as an explicit diff rather
 * than a silent change — see generate-resilience-report.mjs.
 */
export function diffBudgetBaselines(oldBudgets, newBudgets) {
  const oldById = new Map(oldBudgets.map((budget) => [budget.metricId, budget]));
  const newById = new Map(newBudgets.map((budget) => [budget.metricId, budget]));
  const diffs = [];

  for (const [metricId, newBudget] of newById) {
    const oldBudget = oldById.get(metricId);
    if (!oldBudget) {
      diffs.push({ metricId, change: "added" });
      continue;
    }
    const fieldChanges = [];
    for (const key of Object.keys(newBudget)) {
      if (JSON.stringify(oldBudget[key]) !== JSON.stringify(newBudget[key])) {
        fieldChanges.push({ field: key, before: oldBudget[key], after: newBudget[key] });
      }
    }
    if (fieldChanges.length > 0) {
      diffs.push({ metricId, change: "modified", fieldChanges });
    }
  }
  for (const metricId of oldById.keys()) {
    if (!newById.has(metricId)) {
      diffs.push({ metricId, change: "removed" });
    }
  }
  return diffs;
}
