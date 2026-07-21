# Stage 19 Capacity Envelope

Evidence sources:

- Benchmark: `.runtime/stage19/benchmark-1784672808289.json`
- Resilience: `.runtime/stage19/resilience-1784671881306.json`
- Soak: `.runtime/stage19/soak-1784668020358.json`

The committed summary is machine-readable in
`infrastructure/performance/stage19-acceptance-results.json`.

## Environment

| Item               | Value                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| OpenObserve        | `v0.91.2`                                                                 |
| OpenObserve digest | `sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15` |
| Node               | `v24.18.0`                                                                |
| pnpm               | `11.15.0`                                                                 |
| Docker             | `29.6.2`                                                                  |
| Docker Compose     | `5.3.1`                                                                   |
| CPU cores          | `12`                                                                      |
| RAM                | `16478261248` bytes                                                       |

## Measured Envelope

| Metric                           |                            Measured | Budget result |
| -------------------------------- | ----------------------------------: | ------------- |
| `browser.recordAction.p95`       |                               `2ms` | PASS          |
| `browser.recordError.p95`        | `1.8ms` resilience, `2ms` benchmark | PASS          |
| `browser.sanitizer.max`          |                               `1ms` | PASS          |
| `proxy.ingest.p95`               |                               `2ms` | PASS          |
| `proxy.ingest.p99`               |                              `15ms` | observed      |
| `proxy.unexpected5xx`            |                                 `0` | PASS          |
| `openobserve.visibility.p95`     |                              `25ms` | PASS          |
| `query.catalog.p95`              | `25ms` resilience, `27ms` benchmark | PASS          |
| `query.catalog.manifestCount`    |                                `26` | PASS          |
| `alert.notification.recovery`    |                           `12822ms` | PASS          |
| `restart.openobserve.readyTime`  |                            `7847ms` | PASS          |
| `restart.proxy.readyTime`        |                            `6698ms` | PASS          |
| `restart.alertSink.readyTime`    |                            `9543ms` | PASS          |
| `container.memory.peakRatio`     |               `0.25859375298023224` | PASS          |
| `container.fd.postRecoveryDelta` |                                 `0` | PASS          |

## Soak Resource Notes

- 119 samples per service were collected during the 60-minute soak.
- OpenObserve disk usage grew from `13140KiB` to `13864KiB` under expected lab
  telemetry.
- Proxy p95 series stayed between `2ms` and `3ms`.
- No monotonic memory/FD leak flag was raised.
