# Architecture

The product path is:

Browser -> ingress/reverse proxy -> Telemetry Ingest -> RabbitMQ -> Telemetry Delivery Worker -> OpenObserve.

`apps/` contains only deployed product services. Fixture applications live under `tests/fixtures/apps/`.

Runtime config and runtime control are served by `apps/observability-control-plane` through read-only HTTP endpoints. Operator writes happen through `scripts/operator/` and write state atomically to the control-plane state directory.

Session metadata sync reads sanitized `_rumdata`, aggregates metadata only, and writes `_sessionreplay` records with `session_has_replay=false`. It does not create replay segments, DOM snapshots, video, canvas, forms, input values, identity, raw IP, query, or fragment data. OpenObserve v0.91.2's native Sessions query requires an `ip` column in `_sessionreplay`; the product writes the fixed non-IP value `redacted` for UI schema compatibility.
