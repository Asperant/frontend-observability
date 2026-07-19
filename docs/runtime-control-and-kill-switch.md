# Runtime Control and Kill Switch (Stage 14)

## Overview

Stage 14 adds a narrow, frequently-refreshed **runtime control overlay** on top of the immutable
SDK-initialization runtime config (`/observability/config.json`, Stage 7), plus a **kill switch**
enforced at two independent layers:

1. **Browser layer** — a mutable, in-memory collection gate inside
   `@chicek/browser-observability` that RUM/Browser Logs `beforeSend`, `recordAction()`, and
   `recordError()` all consult before doing anything else.
2. **Proxy layer** — the reverse proxy itself, which can return `410 Gone` for both ingestion
   paths before ever calling `proxy_pass`, independent of whether any already-loaded page ever
   re-polls its control document.

Both layers stop **new** collection/ingestion. Neither layer, nor anything in this stage, purges
telemetry already inside the native OpenObserve SDK's own retry queue — see
[Stage 13 limitation](#stage-13-pending-queue-limitation-unchanged) below.

## The control document

Same-origin, exact endpoint: `GET`/`HEAD` `/observability/control.json`, `application/json`, max
8 KiB, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, 3s client fetch timeout.

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "issuedAt": "2026-07-19T19:00:00Z",
  "expiresAt": "2026-07-19T19:05:00Z",
  "killSwitch": { "active": false, "reasonCode": "none" }
}
```

`killSwitch.reasonCode` is a closed enum: `none`, `security_incident`, `privacy_incident`,
`service_degradation`, `maintenance`, `operator_request` — never free text.

This document is deliberately **not** a second full-config system: it carries nothing from the
immutable init config (endpoint, org, service, environment, application ID, version,
token/fingerprint inputs, `sessionSampleRate`, privacy baseline all stay fixed at
`initializeObservability()` time). It is held **memory-only** by the browser package — never
written to `localStorage`, `sessionStorage`, IndexedDB, a cookie, or a service worker cache.

Validation (`packages/browser-observability/src/runtime-control/`):

- unknown top-level or `killSwitch` key → reject (`validate-document.js`)
- `revision`: non-negative integer, monotonic (`apply-document.js`) — equal is a no-op, lower is a
  rejected rollback
- `expiresAt > issuedAt`, TTL capped at 10 minutes, `issuedAt` bounded 60s into the future (clock
  skew), an already-expired-on-arrival document is rejected
- **duplicate JSON keys fail closed** — `duplicate-keys.js` walks the raw response text
  independently of `JSON.parse` (which silently keeps the last value of a repeated key) and
  rejects the whole document if any object literal, at any depth, repeats a key

## Refresh engine

`packages/browser-observability/src/runtime-control/refresh-engine.js`: one timer, one
single-flighted fetch (an `AbortController`-bounded 3s request; a concurrent caller gets the same
in-flight promise, never a second request), normal interval 30s (bounded [15s, 300s]), fixed
failure backoff ladder 15s → 30s → 60s → 120s → 300s, small deterministic (not random) jitter so
the exact schedule is reproducible in tests. `visibilitychange` (becoming visible) and `online`
trigger an immediate out-of-band refresh, still single-flighted against the timer. Duplicate
`initializeObservability()` calls, and a `shutdownObservability()` + re-`initializeObservability()`
cycle on the same page, never produce a second timer or a second pair of listeners. This module
never patches `fetch`/`XMLHttpRequest` globally.

## Fail-closed, last-known-good

A refresh failure while the previously-applied document is still live keeps that document active
(`degraded`). Once nothing live remains — first-ever fetch never having succeeded, or the cached
document's own `expiresAt` lapsing — the collection gate closes (`expired`) regardless of whether
a new fetch is in flight. **No telemetry is ever collected before the first control document is
obtained**: `initializeObservability()` performs this fetch as a hard gate before the adapter (and
therefore any RUM/log collection) is ever initialized, right alongside the existing runtime-config
gate. A failure here disables the runtime with `RUNTIME_CONTROL_UNAVAILABLE`, exactly like an
invalid/unreachable runtime config already does.

## Kill switch and the page latch

Once `killSwitch.active: true` is ever applied during a page's lifetime, it **latches**: the
collection gate stays shut for the rest of that page, even if a later, otherwise-valid,
higher-revision document says `active: false`. The only way to reopen it is a genuinely fresh
`initializeObservability()` **after a full page reload** — the latch lives in a page-lifetime
singleton (`runtime-control/registry.js`) that a real navigation, not a
`shutdownObservability()` + re-`initializeObservability()` cycle, resets. Consent is never touched
by any of this.

## Browser collection gate

`runtime-control/gate.js` holds nothing but a computed open/closed boolean — no payload, URL,
token, or consent content. RUM/Browser Logs `beforeSend` and the public `recordAction()` /
`recordError()` both check it independently (`if (!isCollectionGateOpen()) return false;` /
no-op), so a closed gate is enforced before sanitization, before correlation enrichment, and
before the adapter is ever touched. Closing the gate never changes the package's own lifecycle
state (`active` stays `active`) or the host page's behavior — only new collection stops. The
public API surface is unchanged: still exactly 6 exported functions.

## Reverse-proxy kill switch

`infrastructure/docker/reverse-proxy/conf.d/ingestion.conf`'s two exact locations
(`/rum/v1/default/rum`, `/rum/v1/default/logs`) check a single generated `set` directive
(`$chicek_kill_switch_active`, from `.runtime/generated/proxy-gate.conf`, included at server level
in `app.conf`) before any other policy, method, or `proxy_pass` — when active, both return `410
Gone` with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and OpenObserve is
never reached (verified with OpenObserve stopped: the response is identical). `410` is not one of
the native OpenObserve SDK's own retry-triggering statuses (`408`/`429`/5xx — see
[`docs/openobserve-sdk-delivery-behavior.md`](openobserve-sdk-delivery-behavior.md)), so this does
not provoke a retry storm. All Stage 12 protections (method/content-type/encoding checks,
body/rate/connection limits, header stripping, privacy-safe logs, replay/management-plane denial,
no wildcard `proxy_pass`) are unchanged.

## Operator commands

```bash
pnpm lab:kill-switch:on --reason security_incident
pnpm lab:kill-switch:status
pnpm lab:kill-switch:off
```

(`scripts/lab/kill-switch.mjs`, `scripts/lab/generate-runtime-control.mjs`,
`scripts/lab/proxy-gate.mjs`.) Every publish is schema/lifetime-validated before being written,
atomically (temp file + rename, mirroring `scripts/lab/generate-runtime-config.mjs`), to
`.runtime/generated/` — never committed to the repo, never logged. `nginx -t` must pass before a
reload is attempted, and the reload's result is itself re-verified.

**Activation** order (proxy first): close the proxy gate → validate/reload nginx → bump the
control revision and publish `active: true`. Closing the network path before telling any page
about it means there is never a window where a page could still be told "collection is fine" while
new requests would already be rejected — the fail-closed direction always goes first.

**Deactivation** order (browser first): publish `active: false` → open the proxy gate →
validate/reload nginx. Already-open pages are still page-latched (see above) and will not resume
collection until they are reloaded, even though both layers are now open again.

## Status

`getObservabilityStatus().runtimeControl` — secrets-free:

```js
{
  state,            // fresh | refreshing | degraded | expired | invalid | rollback-rejected | kill-switched
  revision, expiresAt, lastCheckedAt, lastAppliedAt, consecutiveFailures,
  killSwitch: { active, latched, reasonCode },
  counters: {
    refreshSucceeded, refreshFailed, invalidRejected,
    rollbackRejected, expiredFailClosed, killSwitchActivated,
  },
}
```

Never the raw control document body, the endpoint's internal details, a token, a stack trace, or
incident free text.

## Stage 13 pending-queue limitation (unchanged)

Both kill-switch layers stop **new** telemetry from being collected/ingested. Neither claims to
purge telemetry already inside the native `@openobserve/browser-rum`/`browser-logs` SDK's own
retry queue at the moment the kill switch activates — that limitation is unchanged from
[`docs/telemetry-delivery-security-decision.md`](telemetry-delivery-security-decision.md) (Stage
13, still Security Blocked). If the SDK had already accepted an event into its own queue before
the browser gate closed (e.g. it was mid-retry against a temporarily unreachable OpenObserve), that
event can still be flushed once connectivity recovers. This stage adds no SDK private-API use, no
global transport patch, no second network queue, and no custom gateway — the same rejected options
as Stage 13 — and never claims `"purged"`, `"delivered"`, or `"stored"` anywhere in status or docs.

## Rollback and incident procedure

1. Run `pnpm lab:kill-switch:on --reason <security_incident|privacy_incident|service_degradation|maintenance|operator_request>`.
   The proxy stops ingestion within one `nginx` reload; already-open pages stop collecting within
   at most one refresh cycle (≤ 30s under normal conditions, sooner via `visibilitychange`/`online`).
2. Confirm with `pnpm lab:kill-switch:status` (revision, `killSwitch.active`, proxy gate state —
   no secrets are ever printed).
3. Investigate/remediate.
4. Run `pnpm lab:kill-switch:off`. Already-open pages remain latched and inert until reloaded —
   this is intentional (see [Kill switch and the page latch](#kill-switch-and-the-page-latch)); a
   real incident response should treat "ask affected sessions to reload" as part of full recovery,
   not assume they silently resume.
5. Both layers are independent: either can be operated alone for a narrower response (e.g. the
   proxy layer alone during a purely ingestion-side incident, leaving already-open pages free to
   keep collecting into their own — now-blocked — outbound requests without a client-side latch).
