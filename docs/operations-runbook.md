# Operations Runbook

Health and readiness:

- `apps/telemetry-ingest`: `/healthz`, `/readyz`
- `apps/telemetry-delivery-worker`: `/healthz`, `/readyz`
- `apps/observability-control-plane`: `/healthz`, `/readyz`
- `apps/session-metadata-sync`: `/healthz`, `/readyz`

Runtime control:

- Disable collection: `pnpm operator:runtime-control disable operator`
- Enable collection: `pnpm operator:runtime-control enable`
- Status: `pnpm operator:runtime-control status`

Required runtime control environment variables (fail-closed — see `docs/security-model.md`):

- `apps/telemetry-ingest` requires `OBSERVABILITY_CONTROL_URL`. The service refuses to start if it is missing or not a well-formed URL. Once running, admission fails closed (HTTP 503) whenever the control endpoint is unreachable, times out, returns a non-200, returns malformed JSON, or returns an expired/unsupported/kill-switch-active document.
- `apps/telemetry-delivery-worker` requires `DELIVERY_CONTROL_FILE`. If the env var is unset, the file is missing/unreadable, or its contents are malformed, the worker treats this identically to an explicit hold and does not consume; `/readyz` reports unready until a valid `hold: false` document is present.

Both variables must be present in each service's systemd `EnvironmentFile` (see `docs/production-handoff.md`) and in `infrastructure/docker/compose.yaml` for every environment, including lab.

`apps/session-metadata-sync` readiness contract: `/readyz` reports unready (HTTP 503) until the first `syncOnce()` completes successfully — a persisted watermark file alone does not make the service ready after a restart. A sync that scans zero rows still counts as successful. At most one sync runs at a time; an interval tick that fires while a sync is still in flight is a no-op rather than starting a second, overlapping sync.

Runtime config:

- Publish: `pnpm operator:runtime-config publish <config.json>`
- Status: `pnpm operator:runtime-config status`
- History: `pnpm operator:runtime-config history`

Token rotation should publish new runtime documents, refresh service secret mounts, run readiness verification, and then roll forward gradually. Rollback restores the previous runtime config revision from history and verifies telemetry freshness. `pnpm test:token-rotation` (`scripts/lab/verify-token-rotation.mjs`) live-verifies this end to end: it rotates the RabbitMQ ingest/worker passwords in place (old credential rejected, new credential accepted, zero message loss across the restart), and exercises the OpenObserve delivery-ops ingestion token's real rotation primitive in this OpenObserve build (disable/enable — see the script header for why in-place value rotation of that token is not supported by the pinned OpenObserve version).

Backup, restore, upgrade, and rollback (including the full logical control-plane export/restore, cold data-volume backup, and the RabbitMQ durable-buffer recovery chain) are verified end to end by `pnpm test:recovery` (`scripts/recovery/verify-openobserve-recovery.mjs`). TLS certificate rotation is verified by `pnpm test:tls:rotation`. RabbitMQ topology, OpenObserve desired state, and ingress security are verified through the remaining product-named `test:*` scripts in `package.json`.
