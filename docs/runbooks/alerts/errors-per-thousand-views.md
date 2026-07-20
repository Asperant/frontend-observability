# Errors Per Thousand Views

Meaning: observed error event volume per 1000 observed views exceeded the starter threshold with enough view sample.

False positives: unusual test traffic, bot-like page reloads, view instrumentation gap, or denominator changes after a deploy.

First dashboard/query: Frontend Operations dashboard, `errors-per-1000-views`.

Checks: verify service/environment filters, bounded version if used, `views >= minimum_sample`, and whether numerator and denominator changed together.

Session investigation: drill into recent sanitized errors, then compare affected sessions with view timeline.

Rollback or kill switch: evaluate only if the alert aligns with a release or runtime-control change.

Recovery: confirm the rate falls below recovery threshold for consecutive healthy evaluations.

Owner/escalation: `REQUIRED_COMPANY_OWNER`, `REQUIRED_COMPANY_ESCALATION`.
