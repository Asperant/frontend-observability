# Stage 19 Restart / Recovery Matrix

Evidence source: `.runtime/stage19/resilience-1784671881306.json`
(gitignored), summarized in
`infrastructure/performance/stage19-acceptance-results.json`.

| Target          | Health recovered | Recovery time | Ingest recovery | Query recovery | Notification recovery | Drift | Restart count |
| --------------- | ---------------: | ------------: | --------------: | -------------: | --------------------: | ----: | ------------: |
| `demo-frontend` |              yes |      `6527ms` |             n/a |            n/a |                   n/a |    no |          pass |
| `mock-api`      |              yes |      `6436ms` |             n/a |            n/a |                   n/a |    no |          pass |
| `reverse-proxy` |              yes |      `6698ms` |          `13ms` |         `21ms` |                   n/a |    no |          pass |
| `alert-sink`    |              yes |      `9543ms` |             n/a |            n/a |              `2430ms` |    no |          pass |
| `openobserve`   |              yes |      `7847ms` |         `331ms` |        `340ms` |             `12822ms` |    no |          pass |

Runtime-control refresh daemon recovery:

```json
{
  "target": "runtime-control-agent",
  "healthRecovered": true,
  "recoveryTimeMs": 1868,
  "oldPidExited": true,
  "newPidAlive": true,
  "killSwitchPreservedDuringRefresh": true,
  "previousRevision": 78,
  "refreshedRevision": 79,
  "finalRevision": 80
}
```

Reverse-proxy restart was additionally covered by the TLS/proxy gates in
`pnpm run lab:verify`, `pnpm run test:stage12:proxy-security`, and the Stage
19 resilience gate. No stale inode or invalid-certificate regression was
observed.
