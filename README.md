# Chicek Frontend Observability

Installable frontend observability platform for browser applications.

## Public Browser API

`@chicek/browser-observability` exposes exactly one ESM entry point:

```js
import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  recordError,
  setTrackingConsent,
  shutdownObservability,
} from "@chicek/browser-observability";
```

Public APIs never throw. They return outcome/status objects with reason codes.

## Browser-Facing Endpoints

- `POST /rum/v1/default/rum`
- `POST /rum/v1/default/logs`
- `GET /observability/config.json`
- `GET /observability/control.json`

No replay, OpenObserve management/search, RabbitMQ, or operator write endpoint is browser-facing.

## Product Flow

Browser -> ingress/reverse proxy -> Telemetry Ingest -> RabbitMQ -> Telemetry Delivery Worker -> OpenObserve

Telemetry must pass through the queue-backed delivery path; there is no browser persistent queue.

## Repository Layout

- `apps/telemetry-ingest`: browser admission service.
- `apps/telemetry-delivery-worker`: RabbitMQ to OpenObserve delivery worker.
- `apps/observability-control-plane`: read-only runtime config/control HTTP service.
- `apps/session-metadata-sync`: metadata-only session sync service.
- `packages/browser-observability`: installable browser package.
- `packages/telemetry-delivery-core`: shared ingest/delivery core.
- `packages/observability-contracts`: JSON schemas and shared validators.
- `tests/fixtures/apps/browser-app`: reference browser fixture app.
- `tests/fixtures/apps/http-test-service`: reference HTTP fixture service.

## Core Commands

- `pnpm install --frozen-lockfile`
- `pnpm run format:check`
- `pnpm run lint`
- `pnpm run test`
- `pnpm run build`
- `pnpm run package:audit`
- `pnpm run test:consumer`
- `pnpm run test:durable-delivery`

The 3650 second durable-outage soak evidence is recorded as a historical acceptance record (`evidence/acceptance/durable-outage-soak.json`) and is not rerun for normal product verification. The raw test artifact from that run was never committed to this repository; the manifest documents the previously-reported result and its provenance rather than claiming the raw evidence is preserved here.
