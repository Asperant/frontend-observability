# OpenObserve Rollback Runbook

## Scope

Rollback is validated only from a known-good pre-upgrade backup. A volume that
has already been opened by the target image must not be opened with the source
image.

Source image:
`public.ecr.aws/zinclabs/openobserve:v0.91.0@sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8`

Target image:
`public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15`

## Procedure

1. Stop the target-version disposable environment.
2. Create a fresh disposable volume.
3. Restore the validated pre-upgrade source backup into that fresh volume.
4. Start the source image against the restored volume.
5. Verify preserved `_rumdata` and `_rumlog` markers.
6. Verify control-plane objects: streams, functions, pipelines, dashboard,
   alert, templates, and destination.
7. Ingest and query a new marker.
8. Verify sanitization redaction/drop and alert firing/resolved destination
   smoke.
9. Remove disposable containers and volumes.

## Re-Upgrade

After rollback, re-upgrade must repeat the upgrade from the same validated
source backup into a new target-version disposable volume. Old and new marker
events must be queryable, and stream/pipeline/dashboard/alert counts must match
the first upgrade.

## Latest Evidence

Machine-readable evidence:
`infrastructure/performance/stage20-recovery-results.json`

Rollback result: `PASS`; startup `6147ms`; elapsed `7322ms`; old `_rumdata`
and `_rumlog` markers preserved; new marker visible; sanitization and alert
smoke passed.

Re-upgrade result: `PASS`; startup `6068ms`; elapsed `7309ms`; old `_rumdata`
and `_rumlog` markers preserved; new marker visible; sanitization and alert
smoke passed.
