# Stage 19 60-Minute Soak Report

Evidence source: `.runtime/stage19/soak-1784668020358.json` (gitignored).

## Result

**PASS.**

| Field                             |                      Value |
| --------------------------------- | -------------------------: |
| Duration                          |                `3600000ms` |
| Started                           | `2026-07-21T21:07:00.358Z` |
| Ended                             | `2026-07-21T22:07:04.786Z` |
| Browser workload passes           |                        `2` |
| Browser engines                   |      `chromium`, `firefox` |
| Scenario clicks                   |                       `48` |
| Notification probes               |                       `39` |
| Runtime-control samples           |                      `119` |
| Min runtime-control TTL remaining |                 `420710ms` |
| Max runtime-control age           |                 `179290ms` |

## Traffic

| Metric          |  Count |
| --------------- | -----: |
| Sent            | `4781` |
| Accepted        | `2560` |
| Expected drop   | `2221` |
| Unexpected drop |    `0` |
| Unexpected 5xx  |    `0` |
| HTTP 200        | `2560` |
| HTTP 410        |    `1` |
| HTTP 429        | `2220` |

Expected drops were controlled policy outcomes: `429` from burst/rate-limit
behavior and one `410` during the kill-switch cycle.

## Restart and Final Marker

```json
{
  "restartCycle": {
    "healthRecovered": true,
    "recoveryTimeMs": 16887,
    "postRestartIngestionVisibilityMs": 338
  },
  "finalMarker": {
    "accepted": true,
    "visibilityMs": 8
  },
  "anyLeakFlagged": false
}
```

No unexpected data loss, crash, unexpected 5xx, persistent memory/FD growth,
or runtime-control expiry was observed.
