# Stage 20 Closeout — Final Gate Acceptance (Section 6)

## Status

**ACCEPTED.**

This is the deferred Section 6 of the Stage 20 closeout: the full mandatory
final gate chain run against the actual final branch state, run after
`main` was fast-forwarded to `e492688` and tagged `stage20-closeout-accepted`.
Run against git commit `e4926885ae1894d1e2e04696fad3dd632d0a549d`.

## Gate Results

| Gate                                                                                                                  | Result                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm run verify` (format/lint/unit/contract/coverage/build/consumer/Chromium+Firefox+WebKit E2E/SBOM/security:local) | PASS                                                                               |
| `pnpm run lint`                                                                                                       | PASS                                                                               |
| Stage 15 (stream/data lifecycle)                                                                                      | PASS                                                                               |
| Stage 16 (dashboard/query governance)                                                                                 | PASS                                                                               |
| Stage 17 (alert/incident governance)                                                                                  | PASS                                                                               |
| Stage 18 (security/privacy acceptance)                                                                                | PASS                                                                               |
| Stage 19 (resilience gate)                                                                                            | PASS (after fixing a real bug found by this run — see below)                       |
| Stage 19 real 60-minute soak (fresh, against final branch state)                                                      | PASS — see `docs/stage19-soak-report.md`                                           |
| Stage 20 full recovery proof (fresh, against final branch state)                                                      | PASS (`ACCEPTED`) — see `infrastructure/performance/stage20-recovery-results.json` |
| Native OpenObserve v0.91.2 UI smoke (Chromium + Firefox)                                                              | PASS (12/12)                                                                       |
| TLS certificate rotation                                                                                              | PASS (live fingerprint change confirmed)                                           |
| Full lab E2E suite (Chromium + Firefox)                                                                               | PASS (34/34)                                                                       |
| `git diff --check`                                                                                                    | PASS                                                                               |
| Secret scan (`security:local`)                                                                                        | PASS                                                                               |
| Final lab health                                                                                                      | PASS — all 5 services healthy                                                      |

## Real Bug Found and Fixed by This Gate Run

Stage 19's network-partition scenario
(`scripts/performance/verify-stage19-resilience.mjs`,
`runNetworkPartitionScenario`) disconnects and reconnects `mock-api` from
the `chicek-lab_app-internal` Docker network to simulate a partition. The
reconnect used a plain `docker network connect`, which restores the
container's own hostname-based DNS record but **not** the Compose-managed
service-name alias (`mock-api`). The scenario's own health check only
polled `mock-api`'s container health (which doesn't depend on DNS), so it
kept reporting `PASS` while the lab was left in a state where
`reverse-proxy` could no longer resolve `mock-api` by hostname — a genuine
502 for every proxied `mock-api` route (`getent hosts mock-api` returned
`SERVFAIL` from inside `reverse-proxy`).

This was caught live by this final gate run's `test:e2e:lab` suite
(`/mock/status/200 works through the reverse proxy` and `config timeout
state is shown` both failed with `CONFIG_HTTP_ERROR`, reproducibly, not
flaky). Root-caused via `docker exec reverse-proxy getent hosts mock-api`
→ `SERVFAIL`, and `docker inspect chicek-lab-mock-api-1` showing an empty
`Aliases` array on that network.

**Fix**: `runNetworkPartitionScenario` now reconnects with
`docker network connect --alias mock-api ...` and asserts DNS resolution
from `reverse-proxy` (`getent hosts mock-api`) as part of the scenario's
own pass/fail condition, so this class of regression can never again
silently report PASS. Verified live: the lab's `mock-api` alias was
manually restored, the previously-failing E2E tests were re-run and
passed, and the Stage 19 resilience gate was re-run end-to-end and passed
cleanly with the new DNS assertion actively exercised
(`recoveryTimeMs=102`, `dnsAliasResolves=true`).

## Alert Scope Hygiene

Confirmed `lab:alerts:status` reports `total=5 starters=5 company=0`
after the full gate chain (soak + resilience + Stage 20 recovery proof +
native UI probes) — no stray test alerts left on the main lab.

## Known Operational Gotcha Re-encountered (Not a New Bug)

The previously-documented Stage 18 F-05 finding (`alert-sink`'s
`network_mode: service:openobserve` binding silently breaks when only
`openobserve` is restarted, not `alert-sink` too) was hit twice more
during this gate run — once after `test:e2e:lab`'s chaos tests, once
before the final native-UI re-confirmation. Both times resolved with the
documented fix (`docker compose ... restart alert-sink`). No code change
needed; this is an inherent property of shared Linux network namespaces,
already tracked as an accepted residual operational note.

## Evidence Files

- `docs/stage19-soak-report.md` — fresh 60-minute soak, this run
- `infrastructure/performance/stage20-recovery-results.json` — fresh Stage 20 recovery proof, this run
- `.runtime/stage19/resilience-1784750880960.json` — Stage 19 resilience gate raw report (gitignored)
- `.runtime/stage20/2026-07-22T19-45-17-599Z/stage20-results.json` — Stage 20 raw report (gitignored)

## Decision

**ACCEPTED.** All mandatory final gates pass against the actual final
branch state. One real bug (network-partition DNS alias loss) was found
and fixed as a direct result of running this gate, with a regression
assertion added so it cannot silently recur.
