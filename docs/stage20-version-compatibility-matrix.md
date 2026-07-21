# Stage 20 Version Compatibility Matrix

## Images

| Role   | Tag       | Digest                                                                    | Status                               |
| ------ | --------- | ------------------------------------------------------------------------- | ------------------------------------ |
| Source | `v0.91.0` | `sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8` | Previous pinned contract confirmed   |
| Target | `v0.91.2` | `sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15` | Current running lab version accepted |

No `latest` tag is used.

## Compose Compatibility

| Surface             | Source `v0.91.0`                                       | Target `v0.91.2`                                       | Compatibility Decision                 |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------- |
| OpenObserve wrapper | Same local entrypoint and healthcheck wrapper          | Same local entrypoint and healthcheck wrapper          | Compatible                             |
| Runtime user        | Non-root OpenObserve user                              | Non-root OpenObserve user                              | Compatible                             |
| Data directory      | `/data` with `ZO_DATA_DIR=/data`                       | `/data` with `ZO_DATA_DIR=/data`                       | Compatible                             |
| Secrets             | Runtime bind-mounted secret files                      | Runtime bind-mounted secret files                      | Compatible; not backed up or committed |
| Alert sink          | Loopback `127.0.0.1:4312` via shared namespace         | Loopback `127.0.0.1:4312` via shared namespace         | Compatible                             |
| Network/ports       | Disposable project, unique host port                   | Disposable project, unique host port                   | Compatible                             |
| Session Replay      | Disabled; `_sessionreplay` absent in target acceptance | Disabled; `_sessionreplay` absent in target acceptance | Compatible                             |

## API Surfaces Exercised

| API Surface                   | Validation                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Streams/settings/schema       | Source fixture, target restore, stream provision second run `NO_CHANGE`, verify `NO_DRIFT` |
| Functions/pipelines           | Existing sanitization provisioner applied and read back                                    |
| Dashboards/folders            | Fixture dashboard created and preserved                                                    |
| Alerts/templates/destinations | Fixture alert stack created and destination smoke passed                                   |
| Ingest/search                 | Old markers preserved and new markers visible after every restore/upgrade path             |
| Sanitization                  | Redaction and secret-drop smoke passed after restore, upgrade, rollback, and re-upgrade    |

## Latest Stage 20 Evidence

`infrastructure/performance/stage20-recovery-results.json`

Decision: `ACCEPTED`.
