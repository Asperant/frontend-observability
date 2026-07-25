# @chicek/browser-observability

Framework-independent browser observability client for Chicek frontend telemetry.

Public ESM API:

- `initializeObservability`
- `setTrackingConsent`
- `recordAction`
- `recordError`
- `getObservabilityStatus`
- `shutdownObservability`

The package never throws from its public API. It reports disabled, rejected,
or degraded states through returned outcome/status objects.
