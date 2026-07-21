# Stage 20 — Backup, Restore, Upgrade Proof, Rollback Acceptance

## Status

**ACCEPTED.** Stage 20 completed against the Stage 19 accepted target image:

`public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15`

Source image:

`public.ecr.aws/zinclabs/openobserve:v0.91.0@sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8`

Machine-readable evidence:
`infrastructure/performance/stage20-recovery-results.json`

Raw runtime-only evidence:
`.runtime/stage20/2026-07-21T22-59-29-194Z/stage20-results.json`

## Backup Manifest

| Role                                | Path                                                                            | SHA-256                                                            |      Bytes |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------: |
| Target logical control-plane export | `.runtime/stage20/2026-07-21T22-59-29-194Z/backups/target-logical-export.json`  | `2397ee30137e942c5f983964b6c85a56f74afdcdc8586b32e65d9c95b857311f` |      18131 |
| Target cold data volume             | `.runtime/stage20/2026-07-21T22-59-29-194Z/backups/target-openobserve-data.tar` | `f62def7cd64e258f3303829905e11ee0bc21cedc4b03f04021bcbafea5ef710e` |   14716928 |
| Source cold data volume             | `.runtime/stage20/2026-07-21T22-59-29-194Z/backups/source-openobserve-data.tar` | `c2360bbf1e377d7e9e0d1e3c1cb83fcb08c8f1ff4a01f6aaaec862a8eb767d0e` | 1078772736 |

Checksums were read back and verified before restore use. The target cold
snapshot volume size was `16012KiB`; the source cold snapshot volume size was
`4960KiB`. RPO for the lab cold snapshot is `0`.

## Recovery Matrix

| Step           | Result | Duration Evidence                  | Integrity Evidence                                                                        |
| -------------- | ------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Target restore | PASS   | startup `6024ms`                   | `6` streams, `2` pipelines, `4` functions, `4` dashboards, `6` alerts, new marker visible |
| Source restore | PASS   | startup `6170ms`                   | old `_rumdata` and `_rumlog` markers preserved; new marker visible                        |
| Upgrade        | PASS   | startup `6083ms`, elapsed `7490ms` | old markers preserved; new marker visible; migration logs `4` warnings, `0` errors        |
| Rollback       | PASS   | startup `6147ms`, elapsed `7322ms` | restored from clean pre-upgrade backup; old markers preserved; new marker visible         |
| Re-upgrade     | PASS   | startup `6068ms`, elapsed `7309ms` | same source backup produced matching object counts; old and new markers queryable         |

Every step passed sanitization redaction/drop and alert destination firing/resolved
smoke validation.

## Security and Governance

| Gate                 | Evidence                                                                                                                 | Result |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| Exact image pinning  | Source and target use explicit tag plus digest                                                                           | PASS   |
| No `latest`          | No OpenObserve `latest` image used                                                                                       | PASS   |
| Session Replay       | `_sessionreplay` absent                                                                                                  | PASS   |
| Stream governance    | Provision second run `_rumdata=NO_CHANGE`, `_rumlog=NO_CHANGE`; verify `_rumdata=NO_DRIFT`, `_rumlog=NO_DRIFT`           | PASS   |
| Proxy/token boundary | Stage 19 accepted security regression remains the baseline; Stage 20 did not alter proxy/token config                    | PASS   |
| Secrets              | Backups and committed JSON contain checksums, counts, and relative paths only; runtime archives remain under `.runtime/` | PASS   |

## Decision

**Stage 20 accepted.** No critical/high or unverifiable mandatory acceptance
criterion remains open for Stage 20.
