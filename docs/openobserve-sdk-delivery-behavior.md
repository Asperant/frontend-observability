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

The package does not add a global transport wrapper and does not patch `fetch`, XHR, or `sendBeacon`.

Because no public response/transport hook is available, no native SDK circuit breaker is implemented. The bounded controls we own are:

- admission sampling before sanitized events are dispatched,
- memory-only manual dispatch queue limits,
- offline drop for new manual events,
- consent revoke/shutdown purge and listener cleanup,
- Stage 12 proxy quick-fail, request size limits, timeout, and rate limits.

The SDK native retry path has bounded queue bytes, in-flight request count, in-flight bytes, and backoff ceiling, but no verified maximum retry count or retry age. Tests and reports must not claim delivery acknowledgement or a fully bounded native retry lifetime.
