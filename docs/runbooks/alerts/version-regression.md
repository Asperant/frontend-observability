# Version Regression

Meaning: a bounded current version has a worse error-session rate than a bounded baseline version by both absolute and relative criteria.

False positives: unbalanced rollout, baseline no longer representative, traffic mix shift, small sample on either version, or `unknown` version records.

First dashboard/query: Error Analysis dashboard, bounded Stage 16 version comparison queries.

Checks: confirm current and baseline version are separate and bounded, `unknown` is excluded, and both sides meet minimum sample.

Session investigation: compare sanitized error classifications and session timelines for current versus baseline.

Rollback or kill switch: consider rollback only after release ownership confirms the regression and product risk is higher than rollback risk.

Recovery: confirm absolute and relative deltas remain below recovery thresholds for consecutive healthy evaluations.

Owner/escalation: `REQUIRED_COMPANY_OWNER`, `REQUIRED_COMPANY_ESCALATION`.
