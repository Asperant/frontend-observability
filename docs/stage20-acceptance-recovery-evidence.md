# Stage 20 — Backup, Restore, Upgrade Proof, Rollback Acceptance

## Status

**ACCEPTED.** Stage 20 completed against the Stage 19 accepted target image:

`public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15`

Source image (historical/upgrade-path context only, never the accepted target):

`public.ecr.aws/zinclabs/openobserve:v0.91.0@sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8`

Machine-readable evidence: `infrastructure/performance/stage20-recovery-results.json`
Raw runtime-only evidence: `.runtime/stage20/2026-07-22T15-58-50-673Z/stage20-results.json`

## What This Proves, and Why the Old Proof Was Replaced

Stage 20's original acceptance relied on object _counts_ and on the
`/alerts/destinations/test` endpoint as evidence of a working alert path.
Both were re-verified live during this closeout and found insufficient:

- Counting objects does not prove the objects are the _same_ objects — a
  restore could silently drop a panel's query or a pipeline's edge and
  still report the same count. This is now proven with per-object and
  per-group SHA-256 semantic hashes over canonicalized (key-sorted,
  null-stripped) object content, not counts.
- `/alerts/destinations/test` (and the manual `PATCH /alerts/{id}/trigger`
  endpoint) were live-verified to send a real notification
  **unconditionally**, even when pointed at an alert whose SQL condition
  is provably false. Neither is evidence that OpenObserve's real
  per-minute scheduler evaluates an alert's condition correctly after a
  restore. This is now proven with a real scheduler-driven probe
  (`scripts/lab/alerts/real-evaluation-probe.mjs`) that observes a genuine
  quiet cycle (`condition_not_satisfied` in Alert History) followed by a
  genuine firing cycle, via the same row-count-based
  `trigger_condition.threshold`/`operator` semantics OpenObserve actually
  uses.

## Backup Manifest

| Role                                | Path                                                                            | SHA-256                                                            |      Bytes |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------: |
| Target logical control-plane export | `.runtime/stage20/2026-07-22T15-58-50-673Z/backups/target-logical-export.json`  | `1cd5abe7cb823e73757d6dd7445a44372c9ae8806f8ce843db80cf0e66af33a5` |     ~201KB |
| Target cold data volume             | `.runtime/stage20/2026-07-22T15-58-50-673Z/backups/target-openobserve-data.tar` | `9da2e9c36ae0fd6e85a38763081f0696a860578b359dfed8028012285c1713e6` | 1625481216 |
| Source cold data volume             | `.runtime/stage20/2026-07-22T15-58-50-673Z/backups/source-openobserve-data.tar` | `e7e013d196324f32d49f12b0849bd929eb3c9b69aad279552cde363493956a42` | 1615644672 |

Target object counts: `2` streams, `4` functions, `2` pipelines, `5`
dashboards, `5` alerts, `9` templates, `1` destination. The target cold
snapshot volume size was `16304KiB`; the source cold snapshot volume size
was `4968KiB`. RPO for the lab cold snapshot is `0` — the cold archive is
taken from a live clone of the volume (`docker run ... cp -a`); the main
lab service is never stopped or touched to produce it.

## Logical Export/Restore Integrity (Section 1.1)

A disposable round-trip environment proved the full logical
control-plane — real object definitions, not counts:

| Check                                                                                                                                           | Result                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Export → disposable restore → re-export, per-group SHA-256 hash equality (streams/functions/pipelines/dashboards/alerts/templates/destinations) | **PASS**                                  |
| Second apply of the same export is a no-op (existence-check idempotent)                                                                         | **PASS** — `secondApplyAllNoChange: true` |

Overall target export hash: `6f28dc93fda1f7ef408838747aca7b6ac4023d0fd7ccc5862518c4ae3ca81856`.
(`schemaFields` on stream objects is excluded from the hash — it is
data-derived and expected to differ between a mature environment and a
freshly bootstrapped one; the raw field is still exported and backed up.)

## Recovery Matrix

| Step                                | Result | Duration Evidence                   | Integrity Evidence                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target restore (cold clone)         | PASS   | startup `6305ms`                    | new marker visible; sanitization redaction/secret-drop passed; real alert quiet-then-firing proof passed (Alert History `historyRowCountFinal=4`)                                                                                                                  |
| Source (v0.91.0) restore            | PASS   | startup `6144ms`, elapsed `8309ms`  | old `_rumdata`/`_rumlog` markers preserved; new marker visible; sanitization passed; real alert proof passed                                                                                                                                                       |
| Upgrade (v0.91.0 → v0.91.2)         | PASS   | startup `6777ms`, elapsed `22906ms` | old markers preserved; new marker visible; sanitization passed; real alert proof passed                                                                                                                                                                            |
| Rollback (clean pre-upgrade backup) | PASS   | startup `6180ms`, elapsed `12878ms` | old markers preserved; new marker visible; sanitization passed; real alert proof passed                                                                                                                                                                            |
| Re-upgrade                          | PASS   | startup `6085ms`, elapsed `21055ms` | old markers preserved; new marker visible; sanitization passed; real alert proof passed                                                                                                                                                                            |
| Final target logical restore        | PASS   | startup `7655ms`                    | full logical control plane restored onto the re-upgraded target: `17` objects `NO_CHANGE`, `10` objects `CREATED`; old markers preserved; `_sessionreplay` confirmed absent; final overall hash `3e19620d4fd7ede1a2b3680d630d98920e00e6df95e0e59641ea386314ee4421` |

Every recovery-chain step's "real alert proof" means a genuine
scheduler-driven quiet cycle (`condition_not_satisfied` observed in Alert
History) followed by a genuine firing cycle — not a manual trigger and
not `/alerts/destinations/test`.

## Security and Governance

| Gate                 | Evidence                                                                                                                                                                                                     | Result |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Exact image pinning  | Source and target use explicit tag plus digest                                                                                                                                                               | PASS   |
| No `latest`          | No OpenObserve `latest` image used                                                                                                                                                                           | PASS   |
| Session Replay       | `_sessionreplay` absent on the live target and after the final logical restore                                                                                                                               | PASS   |
| Stream governance    | Provision second run `_rumdata=NO_CHANGE`, `_rumlog=NO_CHANGE`; verify `_rumdata=NO_DRIFT`, `_rumlog=NO_DRIFT`                                                                                               | PASS   |
| Proxy/token boundary | Stage 19 accepted security regression remains the baseline; Stage 20 did not alter proxy/token config                                                                                                        | PASS   |
| Alert scope hygiene  | Live main lab holds exactly the 5 accepted starter alerts (a stray `stage19-disposable-company-alert-*` object left over from an earlier Stage 19 resilience run was found and deleted during this closeout) | PASS   |
| Secrets              | Backups and committed JSON contain checksums, counts, and relative paths only; runtime archives remain under `.runtime/`                                                                                     | PASS   |

## Decision

**Stage 20 accepted.** No critical/high or unverifiable mandatory acceptance
criterion remains open for Stage 20.
