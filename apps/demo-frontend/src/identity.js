// The single canonical host identity for this demo app. Every bootstrap
// call, the real lab OpenObserve ingestion, and the Stage 8 OpenObserve
// verification script (scripts/lab/verify-stage8-openobserve.mjs) must all
// use these exact same values so the service/env/version tags on real
// _rumdata and _rumlog records in OpenObserve are consistent and
// verifiable — this file has no other dependencies so it can be imported
// from plain Node scripts as well as the bundled app.
export const DEMO_IDENTITY = Object.freeze({
  service: "demo-frontend",
  environment: "lab",
  version: "2026.07.1",
});
