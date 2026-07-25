# Changelog

## 1.0.0-rc.1

- Productized the frontend observability platform around installable browser package, telemetry ingest, RabbitMQ-backed delivery worker, runtime control plane, and metadata-only session sync.
- Kept Replay recording, DOM/video/canvas/form capture, backend tracing, bypass delivery routes, browser persistent queueing, Safari/WebKit acceptance, and user identity tracking unsupported.
- Recorded the prior 3650 second durable-outage soak as a historical acceptance record (`evidence/acceptance/durable-outage-soak.json`) rather than re-running it; the raw test artifact from that run was never committed to this repository and is not available, so the manifest documents the previously-reported result and its provenance instead. Stage 21 uses shorter refactor recovery checks for its own live gates.

## Stage 20.5

- Added durable frontend telemetry delivery with RabbitMQ publisher confirm admission and worker delivery to OpenObserve.
