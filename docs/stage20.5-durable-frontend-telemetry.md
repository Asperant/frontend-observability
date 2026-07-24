# Stage 20.5 — Durable Frontend Telemetry Delivery

## Architecture

Only browser ingestion path:

```text
Browser -> reverse-proxy -> durable-ingest -> RabbitMQ -> delivery-worker -> OpenObserve
```

Browser endpoints stay unchanged:

- `POST /rum/v1/default/rum`
- `POST /rum/v1/default/logs`

The six public browser APIs stay unchanged. Browser persistent delivery queues are unsupported.
Server-side durable acceptance is supported. Delivery is at-least-once, not exactly-once. RabbitMQ
is a temporary durable buffer, not an archive.

## Admission

`durable-ingest` validates route, method, content type and size; safely decodes the known browser
payload; applies server-side pre-persistence sanitization; creates `schemaVersion`, `eventId`,
`batchId`, `signal` and `receivedAt`; publishes a persistent RabbitMQ message; waits for publisher
confirm; then returns `202`.

Invalid/security payloads return deterministic `4xx`. RabbitMQ unavailable, blocked, full, NACK or
publisher confirm timeout returns `503`. `202` is never returned before publisher confirmation.

## Sanitization

Final chain:

```text
browser sanitizer -> durable-ingest sanitizer -> OpenObserve pipeline sanitizer
```

Before RabbitMQ persistence, `durable-ingest` rejects or removes secrets, passwords, tokens,
private keys, cookies, authorization data, request/response bodies, form/DOM content, replay/video
fields, URL query strings/fragments, raw IP fields and unknown unsafe nested structures. It never
persists raw unsanitized payloads or inbound browser headers.

## RabbitMQ

- exchange: `chicek.frontend.telemetry`, direct, durable
- routing keys: `frontend.rum`, `frontend.log`
- queues: `chicek.frontend.rum.q`, `chicek.frontend.log.q`
- DLQs: `chicek.frontend.rum.dlq`, `chicek.frontend.log.dlq`
- retry TTLs: `30000`, `120000`, `300000` ms
- max attempts: `16` (finite, but long enough for the required real 60-minute OpenObserve outage
  soak before DLQ)
- main/retry bounds: `25000` messages / `134217728` bytes, `reject-publish`
- DLQ bounds: `5000` messages / `33554432` bytes, `reject-publish`

Definitions and policies are provisioned from `infrastructure/docker/rabbitmq/definitions.json`.
AMQP has no host port. The lab RabbitMQ Management UI is loopback-only on `127.0.0.1:15672`.

## Worker

`delivery-worker` consumes with bounded prefetch and manual ACK. It uses the server-side
OpenObserve ingest token mounted as a secret, not browser-provided headers. It ACKs only after
OpenObserve accepts the batch. Transient connection, timeout, `429` and `5xx` failures use delayed
retry queues. Permanent payload failures and exhausted attempts go to DLQ.

Duplicate delivery may occur if the worker crashes after OpenObserve write but before ACK. Loss
must not occur.

Accounting invariant:

```text
durablyAccepted =
  delivered +
  currentlyQueued +
  deadLettered +
  explicitlyPurged +
  expiredByApprovedPolicy

unexpectedLoss = 0
```

`rejectedBySecurity`, `rejectedByCapacity`, `publisherConfirmFailed` and `duplicateObserved` are
tracked separately.

## Operations

The existing kill switch rejects new durable admission and writes the internal worker hold control.
OpenObserve outages do not activate the security kill switch; messages buffer naturally.

Operator commands:

- `pnpm lab:delivery:hold`
- `pnpm lab:delivery:resume`
- `pnpm lab:delivery:drain`
- `pnpm lab:delivery:purge --confirm PURGE-DURABLE-FRONTEND-TELEMETRY`

`delivery-worker` emits aggregate `_chicek_delivery_ops` records when OpenObserve is available.
These records contain queue/dead-letter depth and worker counters/state only; they never contain
queued RUM/log payloads. When OpenObserve is unavailable, inspect RabbitMQ Management plus
container health/logs. There is no custom queue-management UI or custom status/metrics HTTP API.

## Stage 21 Boundaries

Production TLS, ingress/WAF, RabbitMQ/OpenObserve HA, company secret manager integration, storage
sizing, backup retention, alert destinations/owners and backend OTel Collector -> OpenObserve OTLP
remain Stage 21/company responsibilities.
