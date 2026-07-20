# OpenObserve Alert and Incident Governance

Stage 17 adds governed starter alerting for frontend operations without taking ownership of company-managed alerts.

## Ownership

- Metric/query safety is system-managed through the Stage 16 catalog.
- Starter alerts are initial templates only.
- Company alerts may be freely created, edited, or deleted in OpenObserve UI.
- UI changes are never automatically written back to Git.
- Normal install creates only missing never-installed starters; it does not overwrite, delete, or recreate company-deleted starters.

## Production Model

All starter alerts are disabled by default. Production enablement, thresholds, destinations, owners, expected traffic hours, and escalation are `REQUIRED_COMPANY_DECISION`.

Every starter requires minimum sample, consecutive breach count, cooldown, dedup key, recovery condition, `NO_DATA != HEALTHY`, and `QUERY_ERROR != HEALTHY`.

## Destinations

The lab uses a local mock sink on OpenObserve loopback. Notification bodies are bounded aggregate payloads only: alert, severity, service, environment, version, measured value, threshold, sample size, window, time, dashboard/runbook reference, and dedup key.

Notification bodies must not include raw rows, stack/log bodies, raw URLs, query fragments, request/response bodies, cookies, tokens, identity, session ID lists, credentials, or runtime-control bodies.

## Tools

- `pnpm lab:alerts:install-starters`
- `pnpm lab:alerts:status`
- `pnpm lab:alerts:audit`
- `pnpm lab:alerts:export`
- `pnpm lab:alerts:import`
- `pnpm lab:alerts:backup`
- `pnpm lab:alerts:restore-starters --confirm`
- `pnpm lab:alerts:test-notification`
- `pnpm test:stage17:alerts`

Import defaults to validate/dry-run and non-destructive conflict handling. Export and backup normalize read-back data, redact volatile/secret fields, and write runtime candidates only.

## Silence and Incidents

Pinned v0.91.0 did not provide a safely verified bounded silence/maintenance lifecycle. Do not create hidden kill-switch automation. During a kill switch, a runbook may recommend a bounded manual freshness-alert silence only after the company validates start/end expiry and reason codes.

Native incident list/read exists, but create/stats lifecycle was not supported in the lab. Stage 17 therefore uses `incidentReady` metadata through notification + dashboard + runbook. Company ticket/on-call integrations remain Stage 21 scope.

## Stage 11 and 13 Limits

No Session Replay alert is provided. No guaranteed-delivery, stored, purged, or no-event-loss alert is provided. Freshness means only last observed ingestion age, not delivery health.
