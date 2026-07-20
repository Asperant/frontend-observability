# Stage 18 — Security & Privacy Adversarial Acceptance

## Status: SECURITY ACCEPTED WITH LOW RESIDUAL RISKS

Adversarial acceptance pass over the frozen Stage 0–17 architecture
(browser package → browser sanitizer → exact reverse proxy → OpenObserve
pipeline → streams → dashboards/alerts/operator plane). No new product
features were added. Stages 11 (session replay) and 13 (native delivery/
retry-queue purge) remain `SECURITY BLOCKED / CLOSED BY DESIGN` — both were
re-verified, neither was reopened.

See `docs/security-threat-model.md` for the threat model this acceptance
pass was run against, and `infrastructure/security/stage18-control-matrix.json`
for the full control matrix (31 controls).

## Scope and methodology

Stage 18 does not re-implement adversarial coverage that already exists and
is already gated (proxy method/path/encoding matrix — Stage 12; dashboard/
alert correctness auditing — Stage 16/17; secret scanning — pre-existing;
container/TLS/persistence posture — Stage 6). Those are cited as evidence in
the control matrix and re-run as regression. New Stage 18 work targeted the
adversarial surface nothing previously tested:

1. Browser package public-API fuzzing (all 6 exports) + full storage audit
   (`tests/security/stage18/browser-package-adversarial.test.js`, jsdom;
   `lab-adversarial.mjs:checkBrowserStorageAuditLive`, real Chromium +
   Firefox against the real demo-frontend page and real vendor SDK).
2. Real RUM-token capability isolation directly against OpenObserve's admin
   API (`lab-adversarial.mjs:checkTokenCapabilityIsolation`), plus a live
   sweep confirming the management/search/config plane is unreachable
   through the browser-facing proxy
   (`checkManagementPlaneUnreachableViaProxy`).
3. Live (not just static-config) replay-endpoint rejection with an
   admin-side read-back proving no data landed
   (`checkLiveReplayRejection`).
4. Runtime-control adversarial documents served through the real proxy and
   fed to the browser package's own validators
   (`checkRuntimeControlAdversarialDocuments`), plus kill-switch
   symlink/concurrency-race/upstream-closure checks.
5. Adversarial fixtures fed into the existing, reused
   `auditDashboard`/`auditAlertDefinition`/stream-guard functions
   (`tests/security/stage18/governance-audit-adversarial.test.js`).
6. Docker cross-container admin-endpoint reachability probing
   (`checkDockerCrossContainerIsolation`).
7. Alert-sink notification-body privacy under an adversarially-crafted
   destination-test payload (`checkAlertSinkNotificationPrivacy`).

All live checks ran only against the local `chicek-lab` (`https://
127.0.0.1:8443`, `http://127.0.0.1:5080` loopback, real Docker containers) —
no real external target was ever contacted.

## Findings

Every finding below was found, root-caused, fixed with the smallest possible
change, and reverified with both its own adversarial test and the full
existing regression suite (988 vitest tests + all `test:stageNN:*` gates).
No assertion was weakened, no threshold lowered, no test skipped.

| ID   | Severity                                | Stage | Surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Status                                      |
| ---- | --------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| F-01 | MEDIUM                                  | 1     | `sanitizeAttributes` accepts an own `__proto__`/`constructor`/`prototype` key (e.g. from `JSON.parse`) and, via a plain bracket assignment into a `{}` accumulator, silently changes the resulting object's _prototype_ instead of storing a data property — with `decision: "accept"`, no diagnostic reason at all. Reached via both `recordAction`'s `attributes` and `recordError`'s `context`. The same pattern existed in the shared, exported `stripReservedFields` (currently not exploitable end-to-end at either of its two call sites, but latent) and in `scripts/lab/streams/manifest.js`'s parsing of a real OpenObserve admin-API JSON response. | CLOSED                                      |
| F-02 | MEDIUM                                  | 1     | The regex-based PII/secret detector (`redactSensitiveText`, 8 patterns, run before length-truncation) shows super-linear time growth on long string values: ~1.3s at 50,000 chars, ~5.2s at 100,000 chars measured directly; a 10MB value never returned within a 15s timeout, and one individual pattern (`EMAIL_PATTERN`) threw `RangeError: Maximum call stack size exceeded` on it in isolation. A single `recordAction`/`recordError` call with one large attacker- or user-supplied string attribute/message can freeze the host page's JS main thread for seconds to hours.                                                                             | CLOSED                                      |
| F-03 | MEDIUM                                  | 7     | `auditDashboard`/`auditAlertDefinition` (the read-only governance auditors operators rely on to catch bad imported dashboards/alerts) throw instead of flagging on malformed/hostile input: `undefined`/`null` root, non-object tab/panel entries, a non-string `query`/`sql` field (`.match is not a function`), and a circular `destinations` array (`JSON.stringify` throwing). For a _security audit tool_, crashing means the audit never ran and a malformed/malicious definition slips through unreviewed — a fail-open failure mode, not fail-closed.                                                                                                  | CLOSED                                      |
| F-04 | MEDIUM                                  | 6     | Running `killSwitchOn()` and `killSwitchOff()` concurrently (e.g. two separate CLI invocations racing) let their non-atomic steps interleave, leaving the proxy gate and the control document in disagreeing final states (observed: `proxyGateActive=false` while `control.killSwitch.active=true`) — the stronger, proxy-layer protection silently not engaged while status reporting claimed it was active.                                                                                                                                                                                                                                                 | CLOSED                                      |
| F-05 | LOW (operational, not security/privacy) | 9     | Restarting the `openobserve` container alone (not `alert-sink`) breaks `alert-sink`'s `network_mode: service:openobserve` binding — cross-container reachability to the shared loopback silently fails afterward, with both containers' healthchecks staying green (each only checks itself). No data is lost or exposed; only alert _delivery_ is affected until `alert-sink` is also restarted.                                                                                                                                                                                                                                                              | DOCUMENTED, not fixed (see rationale below) |

### Remediation detail

- **F-01, F-02** — `packages/browser-observability/src/sanitization/detectors/keys.js` (new `isReservedObjectKey`, reused by `sanitizers/attributes.js`'s `forbiddenKeyReason` and by `src/correlation/reserved-fields.js`), `scripts/lab/streams/manifest.js` (same guard, independent copy per the existing "pure function of its own arguments" convention in that file), `packages/browser-observability/src/sanitization/limits/limits.js` (new `maxSanitizerScanLength: 4096`) + `sanitizers/string.js` (clamp before regex scanning, truncate-to-`maxLength` order unchanged so realistic-length secrets are still fully redacted). Regression: `pnpm test:unit` (453 tests), `tests/security/stage18/browser-package-adversarial.test.js` (50 tests, including two dedicated bounded-time regression guards).
- **F-03** — `scripts/lab/dashboards/audit.js` (guard non-object dashboard/tab/panel, coerce `query.query` by type instead of by nullishness, flag rather than crash on any of these), `scripts/lab/alerts/audit.js` (guard non-object alert root, `safeStringify` wrapping both `JSON.stringify` call sites, type-guard `hasRawSensitiveSqlProjection`'s `sql.match`). Regression: `tests/lab/dashboards/audit.test.js`, `tests/lab/alerts/audit.test.js` (all pre-existing PASS/RISK-class assertions unchanged), `tests/security/stage18/governance-audit-adversarial.test.js` (40 tests).
- **F-04** — `scripts/lab/common.mjs` (new `withExclusiveLock`, a cross-process exclusive-create lock file — chosen over an in-process mutex specifically because the real-world race is two separate CLI process invocations, which an in-process JS lock cannot protect against), wired into both `killSwitchOn`/`killSwitchOff` in `scripts/lab/kill-switch.mjs`. Regression: `pnpm test:lab` (329 tests), `tests/security/stage18/lab-adversarial.mjs:checkKillSwitchConcurrentRace` re-run — now consistently `PASS`.
- **F-05** — Documented in place: `infrastructure/docker/compose.yaml`'s `alert-sink` service comment. Not fixed with a code/architecture change: the loopback-only shared-netns design is a deliberate decision from an earlier stage (OpenObserve v0.91.0 blocks private-IP destinations by default), and restructuring it is outside Stage 18's minimal-fix mandate. No security or privacy boundary is affected — this is a pure availability/operational note for whoever restarts `openobserve` next.

## Residual risks (accepted, not blocking)

- **Vendor SDK session cookie** (`_oo_s`) — the only item ever persisted by
  the real `@openobserve/browser-core` 0.3.4 default session-persistence
  strategy (a first-party cookie, session id only, no token/PII). Confirmed
  empirically in both Chromium and Firefox. Not owned by this project's own
  code; this is standard RUM-SDK behavior.
- **Alert-sink notification privacy is verified via the local test-sink's
  allowlist end-to-end, not a full live-alert-fires-from-real-data path** —
  waiting out real alert evaluation timing was judged unnecessary given the
  static `auditAlertDefinition` `SENSITIVE_OUTPUT`/row-template check (Stage 17) already covers the template-content risk directly and exhaustively.
- **F-05** above (openobserve-restart / alert-sink netns operational note).
- Standing, previously-accepted risks unchanged by Stage 18: Session Replay
  closed by design (`docs/session-replay-security-decision.md`); native SDK
  retry-queue purge not guaranteed on revoke/shutdown
  (`docs/telemetry-delivery-security-decision.md`).

None of the above are CRITICAL/HIGH, and none are a security/privacy
MEDIUM — all are either LOW or an explicitly non-security/privacy
operational note, consistent with the acceptance gate in the Stage 18 brief.

## Gate results

```text
pnpm install --frozen-lockfile      PASS
pnpm verify                         PASS
pnpm test:lab                       PASS (329 tests)
pnpm lab:purge --yes / lab:up       PASS
pnpm lab:verify                     PASS
pnpm test:stage12:proxy-security    PASS (regression)
pnpm test:stage14:runtime-control   PASS (regression)
pnpm test:stage15:streams           PASS (regression)
pnpm test:stage16:dashboards        PASS (regression)
pnpm test:stage17:alerts            PASS (regression)
pnpm test:stage18:security-acceptance   PASS (new gate — 10 checks + pure-logic suite)
pnpm test:e2e:stage9                PASS (regression)
pnpm test:stage9:leakage            PASS (regression)
pnpm test:stage8:openobserve        PASS (regression)
pnpm test:stage10:correlation       PASS (regression)
pnpm lab:down                       PASS
git diff --check                    PASS (no whitespace errors)
```

Stage 18's own gate exercises both Chromium and Firefox
(`checkBrowserStorageAuditLive`), matching Stage 9/12/14's existing
dual-browser pattern.

## Final decision

**SECURITY ACCEPTED WITH LOW RESIDUAL RISKS.**

All CRITICAL/HIGH and security/privacy MEDIUM findings are closed. Proxy/
path/parser/body/rate boundaries hold. The management plane is unreachable
from the browser. The RUM token carries ingest-only capability, verified
directly against OpenObserve. Direct sanitizer bypass is safe. Session
Replay is closed at every layer, verified live. Runtime control fails
closed under adversarial documents. The kill switch closes upstream and now
stays internally consistent under a concurrency race. Canonical destructive
operations are hard-blocked and resist obfuscation. Dashboard/alert audits
are read-only and now crash-resistant. Notifications/exports/backups carry
no secrets. The secret scanner and Docker isolation checks pass. Stage 8–17
regressions all pass.
