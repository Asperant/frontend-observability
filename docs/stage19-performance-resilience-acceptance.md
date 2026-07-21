# Stage 19 — Performance, Resilience, Failure Isolation Acceptance

## Status

**ACCEPTED.** All required Stage 19 gates passed against the pinned running
OpenObserve image:

`public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15`

Checkpoint before Stage 19/20 closeout:
`ff51aabbb2e6111b0e2488d53b5cb02f9a3f6e34`
(`pre-stage19-20-checkpoint`).

Machine-readable evidence:
`infrastructure/performance/stage19-acceptance-results.json`.
Raw local reports remain gitignored under `.runtime/stage19/`.

## Scope

Stage 19 verified the existing architecture and contracts only:
browser package, runtime-control, reverse-proxy exact ingestion allowlist,
OpenObserve streams/pipelines/dashboards/alerts, alert-sink, and Docker lab
recovery behavior. No OpenObserve upgrade was performed.

## Results

| Area                | Evidence                                                                                                                                                                                                              | Result |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Runtime control     | Agent restart/preserve check: recovery `1868ms`; old PID exited; new PID alive; kill switch preserved; revision `78 -> 79 -> 80`. 60-minute soak TTL never expired: min TTL remaining `420710ms`, max age `179290ms`. | PASS   |
| Error integrity     | Unit/coverage + Stage 18 gates: Error/string/normalized/custom/PII/secret/long-stack/invalid inputs covered; secret and PII policy unchanged.                                                                         | PASS   |
| RUM, logs, UI       | Chromium + Firefox Stage 8 E2E `20/20`; lab E2E `16/16`; full verify Playwright `39/39`. Session Replay remained closed.                                                                                              | PASS   |
| Stream governance   | `_rumdata`/`_rumlog` provision run twice returned `NO_CHANGE`; verify returned `NO_DRIFT`. `_rumdata` CLS type corrected to live `Float64`; distinct allowlist remains `service`, `env`.                              | PASS   |
| Restart/recovery    | Five container restart matrix passed with health recovery and `drift=false` for every service.                                                                                                                        | PASS   |
| Alert chain         | Resilience gate notification readiness `HEALTHY`; final smoke `firing=true resolved=true count=2 failureVisible=true`; starter alerts stayed disabled-by-default for production.                                      | PASS   |
| Performance         | Hard budgets passed: browser, proxy, OpenObserve visibility, query catalog, alert recovery, restart recovery, memory, FD.                                                                                             | PASS   |
| 60-minute soak      | Duration `3600000ms`; `sent=4781`, `accepted=2560`, `expectedDrop=2221`, `unexpectedDrop=0`, `unexpected5xx=0`, final marker visible in `8ms`.                                                                        | PASS   |
| Security regression | Stage 18 security acceptance, Stage 12 proxy security, Stage 9 leakage and Stage 8/10 regressions passed.                                                                                                             | PASS   |

## Gate Commands

```text
pnpm run test:stage19:resilience                 PASS
pnpm run lab:stage19:soak -- --duration=60m      PASS
pnpm run lab:stage19:benchmark                   PASS
pnpm run test:stage14:runtime-control            PASS
pnpm run test:stage15:streams                    PASS
pnpm run test:stage16:dashboards                 PASS
pnpm run test:stage17:alerts                     PASS
pnpm run test:stage18:security-acceptance        PASS
pnpm run test:stage8:openobserve                 PASS
pnpm run test:stage9:leakage                     PASS
pnpm run test:stage10:correlation                PASS
pnpm run test:stage12:proxy-security             PASS
pnpm run test:e2e:stage8                         PASS (20 tests)
pnpm run test:e2e:lab                            PASS (16 tests)
pnpm run lab:verify                              PASS
pnpm verify                                      PASS
```

## Resolved During Closeout

- Docker stats sometimes reports byte sizes as scientific notation
  (`1e+03kB`). The parser now handles that format and the Stage 19 lib
  coverage suite is back to 100%.
- Tests that start OpenObserve without recreating `alert-sink` can leave the
  shared-network notification path unhealthy while container health remains
  green. This existing operational risk is documented from Stage 18; closeout
  used `pnpm run lab:up` before alert evidence and the final notification
  checks passed.

## Decision

**Stage 19 accepted.** No critical/high or unverifiable mandatory acceptance
criterion remains open for Stage 19.
