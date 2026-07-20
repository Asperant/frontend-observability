# Web Vital Degradation

Meaning: observed LCP p75 degraded above the starter threshold for enough sampled views.

False positives: missing browser vital data, unusual device/network mix, lab CPU pressure, or small sample. Missing vital data is not a failure.

First dashboard/query: Performance and Resources dashboard, `web-vital-lcp-percentiles`.

Checks: confirm service/environment/version scope, `sample_count >= minimum_sample`, and compare p50/p75/p95 trend.

Session investigation: inspect affected view timelines and nearby resource latency; do not treat absent vital fields as failed vitals.

Rollback or kill switch: evaluate only when degradation correlates with a release and user-impact evidence is clear.

Recovery: confirm p75 falls below recovery threshold for consecutive healthy evaluations.

Owner/escalation: `REQUIRED_COMPANY_OWNER`, `REQUIRED_COMPANY_ESCALATION`.
