# Production Handoff

## Company Handoff Checklist

- Confirm company ingress/WAF allows only the four browser-facing routes.
- Confirm TLS SAN, expiry, fingerprint, and rotation smoke checks.
- Confirm secret-file or secret-manager mounts for all runtime credentials.
- Confirm RabbitMQ topology, capacity, and readiness.
- Confirm OpenObserve streams, functions, pipelines, dashboards, and alerts.
- Confirm canary rollout, rollback, backup, and restore procedures.
- Confirm browser package tarball SHA-256 and contents.
- Confirm Replay recording, backend traces, Safari/WebKit acceptance, user identity tracking, and Source Maps baseline remain unsupported.
- Confirm the company has provisioned `OBSERVABILITY_CONTROL_URL` (`telemetry-ingest.env`) and `DELIVERY_CONTROL_FILE` (`telemetry-delivery-worker.env`) in every environment's systemd `EnvironmentFile` — both are required, fail-closed runtime controls (see `docs/security-model.md`); missing either one stops the corresponding service from admitting/consuming telemetry rather than silently bypassing the control.

OpenObserve UI capability source of truth: `infrastructure/openobserve/ui-capabilities.json`.

## Linux/systemd Production Reference

The company production target is a plain Linux host running each service under systemd (no Kubernetes requirement or assumption). Docker Compose (`infrastructure/docker/`) is a reference lab/test environment only and is not the deployment target.

Unit files: `infrastructure/systemd/{telemetry-ingest,telemetry-delivery-worker,observability-control-plane,session-metadata-sync}.service`.

Directory and permission contract (enforced by `pnpm test:linux-reference` / `scripts/operator/verify-linux-reference.mjs`):

- `/opt/chicek-observability/current` — install root (`WorkingDirectory`), read-only at runtime.
- `/etc/chicek-observability/<service>.env` — `EnvironmentFile` per service; also supports mounted secret files referenced from the env file. Mounted read-only (`ReadOnlyPaths=/etc/chicek-observability`).
- `/var/lib/chicek-observability/<service>` — per-service writable state directory (`ReadWritePaths`), e.g. `telemetry-ingest`, `telemetry-delivery-worker`, `control-plane`, `session-metadata`.

Each service runs as its own unprivileged Linux user/group (`chicek-telemetry-ingest`, `chicek-telemetry-delivery`, `chicek-control-plane`, `chicek-session-metadata`) with `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `PrivateDevices=true`, empty `CapabilityBoundingSet=`, and `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`.

Logging goes to journald (`StandardOutput=journal`, `StandardError=journal`) — no file-based log shipping is required on the host. Restart policy is `Restart=on-failure` with health/readiness exposed via each service's `/healthz` and `/readyz`.

Run `pnpm test:linux-reference` after any change to the unit files or this contract to re-validate before rollout.
