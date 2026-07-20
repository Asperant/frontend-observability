# Telemetry Stale

Meaning: last observed ingestion age exceeded the company-defined expected traffic window.

This does not mean all telemetry is delivered, delivery is healthy, or no event loss occurred.

False positives: outside expected traffic hours, lab shutdown, traffic pause, runtime config disabled, OpenObserve ingest delay, or service/environment mismatch.

First dashboard/query: Frontend Operations dashboard, `last-observed-ingestion-age-rumdata`.

Checks: confirm service/environment/version scope, expected traffic hours, and maximum silence decision.

Session investigation: verify whether any recent views/actions/errors/resources exist for the same scope.

Rollback or kill switch: if a kill switch intentionally pauses telemetry, consider a bounded manual silence only with start/end and reason.

Recovery: confirm fresh telemetry is observed within the company-defined window for consecutive healthy evaluations.

Owner/escalation: `REQUIRED_COMPANY_OWNER`, `REQUIRED_COMPANY_ESCALATION`.
