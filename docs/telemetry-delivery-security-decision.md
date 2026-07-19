# Telemetry Delivery Security Decision

## Status: Unsupported (Stage 13, Security Blocked)

Stage 13 (sampling, queue, retry and outage behavior) does not ship an application-level
delivery guarantee layer. Telemetry submitted through the public API (`recordAction`,
`recordError`, and the SDK's own automatic collection) is handed directly to the installed
`@openobserve/browser-rum` / `@openobserve/browser-logs` 0.3.4 native transport, exactly as it
was before this stage was attempted. No manual queue, sampling gate, or retry wrapper is
layered on top of it.

See [`docs/openobserve-sdk-delivery-behavior.md`](openobserve-sdk-delivery-behavior.md) for the
full source-verified audit this decision is based on.

## Why

The native SDK retry queue is bounded in the dimensions we could verify from source:

- retry queue: 20 MiB,
- in-flight requests: 32,
- in-flight bytes: 80 KiB,
- backoff ceiling: 60 seconds.

Two facts could not be verified from the installed source tree:

- a maximum retry count,
- a maximum retry age.

No public purge API, response hook, or transport hook is exposed by the SDK. `createHttpRequest()`
has an internal observable, but it is not reachable without depending on private SDK internals.
Consequence: consent revoke and `shutdownObservability()` can stop the SDK from accepting _new_
telemetry, but cannot guarantee that telemetry already accepted into the SDK's own retry queue
before revoke/shutdown is purged. If OpenObserve is unreachable when that telemetry was queued,
it can still be flushed to storage after recovery, after the user has revoked consent or the app
has shut down observability.

The following were considered and are explicitly out of scope for this project, not partial
mitigations:

- **Global transport patch** (wrapping `fetch`/`XMLHttpRequest`/`sendBeacon`) to intercept and
  drop in-flight native requests: this would fight the vendor SDK's own request lifecycle from
  outside it, is fragile across SDK versions, and was rejected for the same reason a custom
  gateway sanitizer was rejected in the [session replay decision](session-replay-security-decision.md).
- **Private API access** to the SDK's internal transport observable: not a supported surface,
  can break silently on any patch release.
- **A second, project-owned native-style queue** in front of the SDK to fully replace its
  transport: this reimplements retry/backoff/offline logic the vendor SDK already owns, and was
  rejected as out of scope for the same reason — it does not change what the _installed_ SDK
  does with data it already accepted, it only adds a second bounded queue upstream of it.
- **A custom gateway** to intercept or discard in-flight requests server-side: out of scope for
  the same reasons captured in the session replay decision — it does not change the guarantee
  the SDK itself makes about telemetry it has already accepted.

Because none of these are available or in scope, no purge-on-revoke or purge-on-shutdown
guarantee can be made for telemetry already inside the native SDK retry queue.

## Consequence

- Stage 13 is **blocked**. No application-level sampling, manual queue, or retry/backoff layer
  ships.
- `recordAction` / `recordError` submit directly to the native SDK transport, as they did before
  Stage 13 was attempted.
- No delivery acknowledgement, "delivered", or "stored" guarantee is claimed anywhere in status,
  diagnostics, or documentation.
- [`tests/contract/native-delivery-limitation.test.js`](../tests/contract/native-delivery-limitation.test.js)
  is a permanent regression guard: it re-verifies the bounded/unbounded facts above directly from
  the installed SDK source, confirms the public package API is still exactly 6 functions, and
  confirms this package does not patch global transports or add a persistent delivery queue.

## Reassessment

Revisit this decision only if:

- an OpenObserve browser SDK upgrade adds a documented maximum retry count/age, a public purge
  API, or a public response/transport hook, or
- the user makes an explicit, informed architectural decision to accept the residual risk (a
  policy decision, not a technical fix — the same bar applied in the session replay decision).
