# Session Replay Security Decision

## Status: Unsupported (Stage 11, Security Blocked)

Session replay is disabled and unsupported with the pinned OpenObserve OSS version. The
replay ingestion path is not opened, the reverse proxy allowlist has no `/replay` route, and
the runtime config schema cannot express an enabled replay feature.

## Why

OpenObserve OSS v0.91.0 replay masking is client-side only. The real
`@openobserve/browser-rum` 0.3.4 SDK applies `defaultPrivacyLevel` masking before a segment
is compressed and sent — OpenObserve itself performs no server-side content validation of
what it receives.

A schema-valid, correctly deflate-compressed malicious replay payload, sent directly to the
real replay ingestion endpoint with the real RUM client token (bypassing the browser and the
SDK entirely), is accepted and written to the `_sessionreplay` stream unmodified. OpenObserve
only validates the request envelope (multipart shape, deflate encoding) and rejects malformed
requests with `400` — it does not inspect or sanitize segment content.

The RUM client token is a browser-visible capability, not a secret: it is embedded in every
page load by design (the same model already accepted for the `/rum` and `/logs` ingestion
endpoints). Because of this, client-side masking is not a security boundary against a party
that already holds the token — it only protects the honest, in-browser recording path.

A custom gateway, Lua, or njs sanitizer in front of the ingestion endpoint is out of scope: it
would duplicate replay-segment parsing/deflate-decoding logic outside the vendor SDK, is not a
sanctioned mitigation for this project, and does not change the fact that OpenObserve itself
provides no server-side fail-closed guarantee.

## Consequence

- The session-replay ingestion path (`/rum/v1/default/replay`) is not allowlisted in the
  reverse proxy.
- Replay sampling is always `0`; the SDK is never given a non-zero
  `sessionReplaySampleRate`.
- The runtime config schema has no field capable of enabling replay
  (`sessionReplay.enabled` is permanently locked to `false`).
- The OpenObserve adapter never calls the SDK's manual replay-start method.
- `infrastructure/openobserve/sanitization/rum.vrl` (the `_rumdata` ingestion pipeline)
  unconditionally force-sets every ingested event's `session.has_replay` to `false` —
  not only when the field is missing. The RUM client token is a non-secret, browser-exposed
  credential (Stage 8), so a direct, non-SDK POST to `/rum/v1/default/rum` could otherwise
  forge `session.has_replay:true` straight through; this closes that specific gap
  server-side, live-verified by forging exactly that and confirming the stored record still
  reads `false`.

## `_sessionreplay` now holds derived metadata (never real recordings)

OpenObserve's own native RUM → Sessions page (see
`docs/openobserve-v0.91-dashboard-capabilities.md` finding #21) turned out to need more than
just the `session_has_replay` field: its session list's browser/OS/duration columns come from a
*second* query against the `_sessionreplay` stream itself
(`SELECT min(start), max(end), min(user_agent_user_agent_family), min(user_agent_os_family),
min(ip), min(source) FROM "_sessionreplay" WHERE session_id IN (...)`) — with that stream never
existing, the page couldn't render a session list at all, only an empty onboarding banner.

`scripts/lab/sync-session-metadata.mjs` (run continuously by a background daemon `lab:up`
starts — `scripts/lab/session-metadata-daemon.mjs`, a 60s-interval sibling of the existing
runtime-control refresh daemon) now populates exactly those fields — `session_id`, `start`,
`end`, `user_agent_user_agent_family`, `user_agent_os_family`, `ip`, `source` — computed purely
by aggregating `_rumdata`'s own already-sanitized fields per session (`min`/`max` over a
recent, bounded window). This is the same class of plaintext summary data already visible on
every `_rumdata` row; nothing new is derived or exposed. It is not, and cannot become, Session
Replay:

- No DOM mutation, canvas frame, HTML snapshot, or any other replay-segment-shaped content is
  ever produced, by this script or anything else in this project.
- `/rum/v1/default/replay` — the only endpoint a real replay segment could ever arrive through —
  stays unallowlisted at the reverse proxy, unchanged.
- The vendor SDK still never records anything (sampling `0`, manual-start-only, the adapter
  never calls the record-start method) — unchanged.
- `tests/e2e/native-ui-lab.spec.js` pins both properties as live regression guards: one test
  asserts `_sessionreplay`'s schema is exactly this metadata field allowlist (nothing
  segment-shaped ever appears), and a second clicks into a real session's replay view and
  asserts it always shows `00.00 / 00.00` with zero `<canvas>`/`<iframe>` elements — i.e. the
  player UI exists, but there is provably nothing to play back, ever.

## Reassessment

Revisit this decision only if OpenObserve adds a reliable, server-side fail-closed content
validation for the replay ingestion path (e.g. a documented, enabled-by-default rejection of
segments that fail schema/content checks it performs itself) — not by adding sanitization
logic outside of OpenObserve in this project's own infrastructure.
