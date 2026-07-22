# Stage 19 60-Minute Soak Report

Evidence source: `.runtime/stage19/soak-1784745805122.json` (gitignored).
Run against the final Stage 20 closeout branch state, git commit
`e4926885ae1894d1e2e04696fad3dd632d0a549d` (`main` / `stage20-closeout-accepted`).

## Result

**PASS.**

| Field                             |                      Value |
| --------------------------------- | -------------------------: |
| Duration                          |                `3600000ms` |
| Started                           | `2026-07-22T18:43:25.122Z` |
| Ended                             | `2026-07-22T19:43:28.083Z` |
| Browser workload passes           |                        `2` |
| Browser engines                   |      `chromium`, `firefox` |
| Scenario clicks                   |                       `48` |
| Notification probes               |                       `39` |
| Runtime-control samples           |                      `119` |
| Min runtime-control TTL remaining |                 `421030ms` |
| Max runtime-control age           |                 `178970ms` |

## Traffic

| Metric          |  Count |
| --------------- | -----: |
| Sent            | `4781` |
| Accepted        | `2518` |
| Expected drop   | `2263` |
| Unexpected drop |    `0` |
| Unexpected 5xx  |    `0` |
| HTTP 200        | `2518` |
| HTTP 410        |    `1` |
| HTTP 429        | `2262` |

Expected drops were controlled policy outcomes: `429` from burst/rate-limit
behavior and one `410` during the kill-switch cycle.

## Restart and Final Marker

```json
{
  "restartCycle": {
    "healthRecovered": true,
    "recoveryTimeMs": 16829,
    "postRestartIngestionVisibilityMs": 319
  },
  "finalMarker": {
    "accepted": true,
    "visibilityMs": 9
  },
  "anyLeakFlagged": false
}
```

No unexpected data loss, crash, unexpected 5xx, persistent memory/FD growth,
or runtime-control expiry was observed. All 39 notification probes reported
`HEALTHY`.

## Note on Prior Run

An earlier soak (`.runtime/stage19/soak-1784668020358.json`, 2026-07-21) had
already closed Stage 19's original "60-minute soak deferred" limitation and
is what backed the `19 (Performance & Resilience) — ACCEPTED` status set
earlier in this closeout. This report documents a second, independent
60-minute soak run specifically against the _final_ Stage 20 closeout
branch state (Section 6 of the closeout — deferred mid-session, completed
afterward), confirming the result still holds after all Stage 20 changes.
