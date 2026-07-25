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
