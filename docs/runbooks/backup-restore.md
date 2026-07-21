# OpenObserve Backup and Restore Runbook

## Scope

This runbook covers lab-only OpenObserve backup and restore validation for the
current pinned target version:

`public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15`

Do not use canonical streams or the main lab volume for destructive restore
tests. Restore validation must use a disposable Docker Compose project, separate
ports, and disposable volumes.

## Backup

1. Confirm the lab is healthy with `pnpm run lab:verify`.
2. Export logical control-plane state: streams/settings, stream schemas,
   functions, pipelines, dashboard folders, dashboards, alerts, templates, and
   destinations.
3. Stop only the OpenObserve process before copying the data volume.
4. Create a cold tar archive of the OpenObserve data volume.
5. Start the lab again with `pnpm run lab:up`.
6. Produce a manifest containing file paths, byte sizes, SHA-256 checksums,
   object counts, source image tag/digest, target image tag/digest, timestamp,
   and volume size.

Secrets, runtime token files, private keys, temporary logs, screenshots, and
volume archives stay under `.runtime/` and are not committed.

## Restore Validation

1. Create a disposable Compose project with the pinned target image.
2. Restore the cold archive into a disposable `openobserve-data` volume.
3. Start OpenObserve and wait for container health plus API readiness.
4. Verify control-plane object counts.
5. Query preserved marker telemetry.
6. Ingest a new RUM marker and query it back.
7. Verify sanitization by checking email redaction and secret-drop behavior.
8. Verify alert delivery with firing and resolved destination smoke calls.
9. Verify `_sessionreplay` is absent.
10. Remove the disposable containers and volumes.

## Latest Evidence

Machine-readable evidence:
`infrastructure/performance/stage20-recovery-results.json`

Runtime-only raw evidence:
`.runtime/stage20/2026-07-21T22-59-29-194Z/stage20-results.json`

Target backup manifest:

| File                                                                            | SHA-256                                                            |    Bytes |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------: |
| `.runtime/stage20/2026-07-21T22-59-29-194Z/backups/target-logical-export.json`  | `2397ee30137e942c5f983964b6c85a56f74afdcdc8586b32e65d9c95b857311f` |    18131 |
| `.runtime/stage20/2026-07-21T22-59-29-194Z/backups/target-openobserve-data.tar` | `f62def7cd64e258f3303829905e11ee0bc21cedc4b03f04021bcbafea5ef710e` | 14716928 |

Restore result: `PASS`; startup `6024ms`; restored target volume `16012KiB`;
new marker visible; sanitization redaction/drop passed; alert firing/resolved
smoke passed.
