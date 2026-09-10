# @frontend-observability/browser-observability

Framework-independent browser observability client for frontend telemetry.

Public ESM API:

- `initializeObservability`
- `setTrackingConsent`
- `recordAction`
- `recordError`
- `getObservabilityStatus`
- `shutdownObservability`

The package never throws from its public API. It reports disabled, rejected,
or degraded states through returned outcome/status objects.
