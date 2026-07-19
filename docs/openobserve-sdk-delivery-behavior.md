# OpenObserve Browser SDK Delivery Behavior

Audit date: 2026-07-19

Audited local packages:

- `@openobserve/browser-rum@0.3.4`
- `@openobserve/browser-logs@0.3.4`

Source files inspected from the installed package tree:

- `@openobserve/browser-core/esm/transport/flushController.js`
- `@openobserve/browser-core/esm/transport/batch.js`
- `@openobserve/browser-core/esm/transport/httpRequest.js`
- `@openobserve/browser-core/esm/transport/sendWithRetryStrategy.js`
- `@openobserve/browser-core/esm/browser/pageMayExitObservable.js`
- `@openobserve/browser-rum-core/esm/transport/startRumBatch.js`
- `@openobserve/browser-logs/esm/transport/startLogsBatch.js`

## Findings

| Area                           | Verified behavior                                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch/flush interval           | `FLUSH_DURATION_LIMIT` is 30 seconds. `MESSAGES_LIMIT` is 50 in browser runtimes and 1 in worker runtimes. Both RUM and Logs create batches through `createBatch()` and `createFlushController()`.                                              |
| Batch byte/event limits        | Request flush is triggered near `RECOMMENDED_REQUEST_BYTES_LIMIT`, which is 16 KiB. A single message at or above `MESSAGE_BYTES_LIMIT`, 256 KiB, is discarded by the SDK batch layer.                                                           |
| Retry status/network errors    | Retry is attempted for non-opaque responses when status is `408`, `429`, any server error, or status `0` while `navigator.onLine` is false.                                                                                                     |
| Maximum retry/backoff          | Backoff starts at 1 second and doubles up to 60 seconds. The retry queue is bounded at 20 MiB; in-flight transport is bounded at 32 requests and 80 KiB. No maximum retry count or maximum retry age was found.                                 |
| `429` and `Retry-After`        | `429` is retryable. No `Retry-After` response-header parsing was found.                                                                                                                                                                         |
| Offline behavior               | The SDK retries status `0` only while `navigator.onLine` is false and queues failed payloads in memory up to the queue byte cap. It does not expose a public offline admission policy hook.                                                     |
| `pagehide`/unload flush        | Page-exit flush is wired to `visibilitychange` when hidden, `freeze`, and `beforeunload`. The enum contains `page_hide`, but this installed source did not register a `pagehide` listener.                                                      |
| `sendBeacon`/fetch keepalive   | Normal sends use fetch keepalive when supported and payload size is below the 16 KiB request recommendation; otherwise they use fetch. Page-exit sends try `navigator.sendBeacon` under the same byte condition, then fall back to fetch.       |
| Memory/persistent storage      | Delivery retry state in the inspected transport is memory-only. The SDK has session/context storage elsewhere, but no persistent delivery queue was found in the inspected transport path. This package keeps SDK context persistence disabled. |
| Public response/transport hook | No supported public response or transport hook is exposed through our adapter surface. `createHttpRequest()` has an internal observable, but it is not reachable without wiring private SDK internals.                                          |

## Implementation Decision

**Status: Stage 13 is SECURITY BLOCKED / CLOSED BY DESIGN.** No application-level delivery,
sampling, queue, or retry feature was built on top of the native SDK transport. See
[`docs/telemetry-delivery-security-decision.md`](telemetry-delivery-security-decision.md) for the
full decision and rationale; this section only restates it precisely enough that it cannot drift
out of sync with that decision again.

The package does not add a global transport wrapper and does not patch `fetch`, XHR, or
`sendBeacon`.

Because no public response/transport hook is available, no native SDK circuit breaker is implemented.

It does not implement, and does not claim to implement, any of the following:

- admission sampling layered in front of the SDK (the only "sampling" this package configures is
  the native SDK's own `sessionSampleRate`/`errorSampleRate` options, passed straight through),
- a manual dispatch queue or any other project-owned telemetry queue, in memory or persisted,
- an offline-drop policy for new manual events beyond the SDK's own behavior,
- a purge of the native SDK's retry queue on consent revoke or `shutdownObservability()`,
- guaranteed delivery, or a "delivered"/"stored"/"purged" acknowledgement of any kind.

What `shutdownObservability()` and consent revoke actually do: stop the package from accepting
_new_ telemetry, clear frontend correlation state, and call the adapter's own
`stopSessionReplay()`/`shutdown()` lifecycle methods. Neither stops, drains, nor purges telemetry
the native SDK had already accepted into its own retry queue before that point — there is no
public purge, response, or transport hook to do that with (see the Findings table above).

The only bounded controls this project owns and operates are the Stage 12 reverse-proxy hardening
(exact-path allowlisting, request size limits, timeouts, and rate limits — see `README.md`) and the
[Stage 14 runtime kill switch](runtime-control-and-kill-switch.md) (browser-side and proxy-side
ingestion gates). Neither of those purges telemetry already inside the native SDK's retry queue
either — both are documented as stopping _new_ ingestion only.

The SDK's native retry path itself has a bounded queue byte cap, in-flight request count, in-flight
byte cap, and backoff ceiling (see Findings above), but no verified maximum retry count or retry
age, and no public purge/response/transport hook. Tests and reports must not claim delivery
acknowledgement, a native-queue purge, or a fully bounded native retry lifetime.
