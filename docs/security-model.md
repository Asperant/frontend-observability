# Security Model

The browser package is consent-gated and fail-closed. Public APIs never throw.

Forbidden data classes:

- Replay recording, DOM, HTML, video, canvas, form and input values.
- Headers, bodies, cookies, authorization, tokens, passwords, private keys.
- Raw IP, query, fragment, user email, and uncontrolled user identity.

Sanitization is layered:

Browser -> Telemetry Ingest -> OpenObserve pipeline.

Runtime config rejects unknown fields, duplicate JSON keys, expired/future documents, replay enablement, compatibility privacy profiles, legacy route aliases, selector aliases, and separate error sampling.

Known limitation: if OpenObserve internally decorates records with a service/container IP after pipeline execution, that value is treated as internal infrastructure metadata, excluded from product dashboards/session metadata, and must not be used as end-user identity.

## Server-side runtime control is fail-closed

The kill-switch/hold controls that gate `apps/telemetry-ingest` and `apps/telemetry-delivery-worker` are required security/privacy controls, not optional tuning. Both services are fail-closed: a missing or misconfigured control input stops admission/consumption rather than silently allowing it.

- **Telemetry Ingest** (`OBSERVABILITY_CONTROL_URL`): required at startup — a missing or malformed URL prevents the process from starting at all (`apps/telemetry-ingest/src/runtime-control.js`). At request time, any failure to obtain a valid, unexpired control document (network error, timeout, non-200, malformed JSON, unsupported `schemaVersion`, invalid `revision`, expired document) rejects admission with HTTP 503, and `killSwitch.active === true` rejects admission with HTTP 503. Only a structurally valid, unexpired document with `killSwitch.active === false` allows admission.
- **Telemetry Delivery Worker** (`DELIVERY_CONTROL_FILE`): required for the worker to consume at all — a missing env var, missing/unreadable file, or malformed/non-object document is treated identically to an explicit `hold: true` (`apps/telemetry-delivery-worker/src/control-state.js`). Only a structurally valid document with `hold: false` allows consumption. `/readyz` reports unready (HTTP 503) whenever the control state is invalid **or** validly held — a held worker must never be reported ready, even though the control mechanism itself is healthy in that case.

Neither service ever logs the raw control document body or response; only bounded, fixed reason codes (e.g. `runtime_control_unavailable`, `control_file_missing`) are logged or returned.
