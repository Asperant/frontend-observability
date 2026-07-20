# Resource Failure Rate

Meaning: observed resource events have an elevated HTTP/network failure share.

False positives: lab mock failure scenarios, CDN maintenance, ad/tracker blockers, third-party outage, or small resource sample.

First dashboard/query: Performance and Resources dashboard, `resource-failure-rate`.

Checks: confirm service/environment/version scope, `resources >= minimum_sample`, and whether failures cluster by low-cardinality resource type/status.

Session investigation: inspect resource neighborhood around affected sessions and compare with errors and view timeline.

Rollback or kill switch: consider only if a first-party frontend release introduced the failing resource path.

Recovery: verify failures remain below recovery threshold for consecutive healthy evaluations.

Owner/escalation: `REQUIRED_COMPANY_OWNER`, `REQUIRED_COMPANY_ESCALATION`.
