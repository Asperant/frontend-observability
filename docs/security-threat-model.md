# Security Threat Model — Stage 18

## Status

Adversarial acceptance baseline for the frozen Stage 0–17 architecture. This
document is the reference threat model that `docs/stage18-security-privacy-
acceptance.md` and `infrastructure/security/stage18-control-matrix.json` are
tested against. It does not change the architecture; it records the trust
boundaries and attacker classes that architecture was already built to hold,
and cross-references the two standing residual-risk decisions
(`docs/session-replay-security-decision.md`,
`docs/telemetry-delivery-security-decision.md`) that this stage must not
reopen.

## Frozen architecture

```text
browser package (packages/browser-observability)
  → browser sanitizer (packages/browser-observability/src/sanitization)
  → exact reverse proxy (infrastructure/docker/reverse-proxy)
  → OpenObserve pipeline (VRL sanitization backstop, infrastructure/openobserve/sanitization)
  → streams (_rumdata / _rumlog)
  → dashboards / alerts / operator plane (infrastructure/openobserve/analytics, alerts)
```

Every arrow above is a trust boundary: the component upstream of the arrow is
assumed hostile or fallible by the component downstream, independent of
whether the upstream component is "our own" code.

## Attacker classes

1. **Malicious or compromised page script.** Runs in the same JS realm as the
   browser package (same-origin, e.g. a compromised third-party script, XSS,
   or a malicious host application). Can call all 6 public exports with
   arbitrary arguments, can read/write anything the browser package itself
   can read/write (storage, DOM), cannot forge TLS or bypass the network.
2. **Network attacker without the RUM token.** Can reach `https://
localhost:8443` (the published edge port) but does not know the RUM
   client token, org, or ingestion path shape beyond what the public
   `@openobserve/browser-rum` client-side bundle reveals in browser dev
   tools.
3. **Holder of the leaked RUM client token.** The RUM token is a
   browser-visible, non-secret credential by design (same accepted model as
   Stage 8 onward — see `docs/session-replay-security-decision.md`). This
   attacker can send arbitrary requests to any path/method the reverse proxy
   allows, using the real token, without going through the browser SDK or
   its sanitizer at all. This is the most powerful realistic attacker in
   scope, and the one Stage 18 spends the most adversarial effort on
   (Sections 2–5 of the acceptance report).
4. **Operator/administrator error or a compromised alert destination.** Can
   observe whatever the operator plane (dashboards, alerts, notification
   payloads, exports/backups, proxy/access logs, container inspection)
   exposes. Not assumed malicious, but assumed to eventually make a
   destructive mistake (accidental delete/overwrite of canonical assets) or
   receive a notification body that must not itself leak sensitive content.
5. **Local lab operator with host/filesystem access.** Can attempt
   symlink-replacement, path traversal, or concurrent-write races against
   the runtime-control/kill-switch files, or weaken container/file
   permissions. Cannot rewrite the committed nginx/Docker config (those are
   part of the audited artifact), but can attempt to race the file-watching
   pieces that _are_ runtime-writable (`.runtime/generated/proxy-dynamic/`).

**Explicitly out of scope** (per the Stage 18 brief and the standing Stage
11/13 decisions): production SSO/RBAC/TLS/PKI, real external targets, load/
soak testing, SDK/OpenObserve upgrades, a custom gateway or transport, and
reopening session replay. An attacker who can modify the _committed_ nginx
config, Dockerfiles, or CI is not modeled — that is a supply-chain trust
boundary handled by code review and the secret/SBOM/lockfile gates in
Section 8 of the acceptance report, not by runtime defenses.

## Trust boundary → expected control mapping

| Boundary                                               | Untrusted input                                                                     | Control                                                                                                                                           | Reference                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Host app → browser package                             | Arbitrary JS values into the 6 public exports                                       | `safeCall` never throws; sanitizer bounds/redacts before anything leaves the package                                                              | `packages/browser-observability/src/internal/safe-call.js`, `src/sanitization/**`                      |
| Browser package → proxy                                | Whatever the sanitizer forwards, plus a token-holder bypassing the browser entirely | Exact-path allowlist (`/rum/v1/default/rum`, `/rum/v1/default/logs` only), method/size/rate/connection limits, no cookie/Authorization forwarding | `infrastructure/docker/reverse-proxy/conf.d/{ingestion,security,app}.conf`, Stage 12                   |
| Proxy → OpenObserve                                    | Payload that passed the proxy's envelope checks                                     | VRL sanitization backstop (defense-in-depth, not the primary control)                                                                             | `infrastructure/openobserve/sanitization/*.vrl`, Stage 9                                               |
| RUM token → OpenObserve API surface                    | A non-secret, browser-exposed credential                                            | Token must carry ingest-only capability; management/search/config API calls with it must be rejected                                              | Stage 18 Section 3 (new)                                                                               |
| Runtime-control document → browser/proxy kill switch   | A refreshed, network-delivered control document                                     | Fail-closed on malformed/expired/rolled-back documents; dual-layer enforcement (browser + proxy)                                                  | `docs/runtime-control-and-kill-switch.md`, Stage 14, Stage 18 Section 6 (extended)                     |
| Dashboards/alerts/streams definitions → operator plane | Imported/authored definitions that may encode a privacy or governance violation     | Read-only audit flags (`auditDashboard`, `auditAlertDefinition`), destructive-target hard-block (`validateDestructiveTarget`)                     | `scripts/lab/{dashboards,alerts,streams}/{audit,guard}.js`, Stage 15–17, Stage 18 Section 7 (extended) |
| Repo source → Git/CI/Docker artifacts                  | A committed secret or an unpinned dependency                                        | Tracked-file secret scanner, frozen lockfile, image digest pins                                                                                   | `scripts/security/scan-secrets.js`, Stage 18 Section 8                                                 |

## Standing residual risks (not reopened by Stage 18)

- **Session replay stays closed by design.** OpenObserve OSS v0.91.0 does no
  server-side content validation of replay segments, so client-side masking
  is not a boundary against a token holder. See
  `docs/session-replay-security-decision.md`. Stage 18 adds a _live_ proxy
  rejection check (no reliance on a static config grep alone) as additional
  regression evidence that this stays closed even under direct adversarial
  probing.
- **Native SDK retry-queue purge is not guaranteed.** Consent revoke and
  `shutdownObservability()` stop new telemetry but cannot force-purge
  whatever the vendor SDK's own transport already queued in memory. See
  `docs/telemetry-delivery-security-decision.md`. Stage 18 does not attempt
  to add a purge mechanism (explicitly out of scope: no custom transport) —
  it re-asserts the existing regression guard
  (`tests/contract/native-delivery-limitation.test.js`) and does not claim
  a stronger guarantee anywhere in new Stage 18 artifacts.
