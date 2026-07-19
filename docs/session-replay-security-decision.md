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

## Reassessment

Revisit this decision only if OpenObserve adds a reliable, server-side fail-closed content
validation for the replay ingestion path (e.g. a documented, enabled-by-default rejection of
segments that fail schema/content checks it performs itself) — not by adding sanitization
logic outside of OpenObserve in this project's own infrastructure.
