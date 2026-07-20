# High Error Session Rate

Meaning: a sufficient sample of observed sessions has at least one error above the starter threshold.

False positives: low traffic below true business seasonality, synthetic test traffic, one noisy browser extension pattern, deploy canary traffic, or query scope mismatch.

First dashboard/query: Error Analysis dashboard, `session-error-rate`.

Checks: confirm service, environment, and bounded version filters; verify `sessions >= minimum_sample`; compare current and previous evaluation windows.

Session investigation: open Session Investigation with affected time window, inspect sanitized error classifications and resource neighborhood, never raw stack/body.

Rollback or kill switch: consider only after a real release correlation is confirmed and product owner approves. Do not automate rollback from this alert.

Recovery: confirm the metric is below recovery threshold for the required consecutive healthy evaluations.

Owner/escalation: `REQUIRED_COMPANY_OWNER`, `REQUIRED_COMPANY_ESCALATION`.
