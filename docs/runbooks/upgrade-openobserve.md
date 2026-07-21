# OpenObserve Upgrade Runbook

## Scope

Stage 20 validates the existing project upgrade path only:

| Role   | Image                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| Source | `public.ecr.aws/zinclabs/openobserve:v0.91.0@sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8` |
| Target | `public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15` |

Do not select a newer OpenObserve version during this runbook. Do not open a
target-mutated volume with the source image.

## Procedure

1. Start a disposable source-version Compose project on a non-main port.
2. Create fixture telemetry in `_rumdata` and `_rumlog`.
3. Provision the existing stream settings and sanitization functions/pipelines.
4. Create one dashboard, one alert, one destination/template set, and marker
   telemetry.
5. Stop source OpenObserve before snapshotting the data volume.
6. Verify the source backup checksum.
7. Restore the validated source backup into a separate disposable volume.
8. Start the target image against that restored volume.
9. Record startup duration, elapsed upgrade duration, warning/error counts, and
   disk size.
10. Query old markers and ingest/query a new marker.
11. Verify sanitization redaction/drop and alert firing/resolved destination
    smoke.
12. Remove the disposable project and volume.

## Latest Evidence

Machine-readable evidence:
`infrastructure/performance/stage20-recovery-results.json`

Validated source backup:

| File                                                                            | SHA-256                                                            |      Bytes |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------: |
| `.runtime/stage20/2026-07-21T22-59-29-194Z/backups/source-openobserve-data.tar` | `c2360bbf1e377d7e9e0d1e3c1cb83fcb08c8f1ff4a01f6aaaec862a8eb767d0e` | 1078772736 |

Upgrade result: `PASS`; startup `6083ms`; elapsed `7490ms`; volume after
upgrade `5104KiB`; old `_rumdata` and `_rumlog` markers preserved; new marker
visible; control plane preserved with `2` streams, `2` pipelines, `4`
functions, `1` dashboard, `1` alert, `9` templates, and `1` destination.

Migration logs recorded `4` warnings and `0` errors. The warnings were WAL
replay messages during normal startup replay.
