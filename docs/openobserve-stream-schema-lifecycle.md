# OpenObserve Stream, Schema and Data-Lifecycle Governance (Stage 15)

This stage governs the two canonical OpenObserve streams Stage 8 already created
(`_rumdata`, `_rumlog`): their settings (retention, query range, UDS, index/partition),
their schema contract and drift classification, a safe provisioning workflow, a
destructive-operation guard, and a disposable-stream lifecycle test harness — all against
the real, pinned OpenObserve `v0.91.0` API. It does not add a dashboard, an alert, a
Collector/gateway, an SDK upgrade, or per-user identity deletion; see
[Scope boundaries](#scope-boundaries).

Every capability claim in this document is backed by a live probe against the pinned
binary — see [`docs/openobserve-v0.91-stream-capabilities.md`](openobserve-v0.91-stream-capabilities.md)
for the full, verified capability matrix this stage is built on.

## Canonical streams

Only two streams are ever managed:

```text
_rumdata   (RUM: view/action/error/resource/long_task/vital events)
_rumlog    (browser logs)
```

Rules, enforced structurally rather than just documented:

- **No `_rumreplay` or any other session-replay stream.** Session replay stays disabled
  by committed decision (Stage 11, still `SECURITY BLOCKED`,
  [`docs/session-replay-security-decision.md`](session-replay-security-decision.md)).
  Every Stage 15 gate that touches real ingested data also asserts `_rumreplay` has no
  records (`scripts/lab/verify-stage15-streams.mjs`).
- **No per-service/per-environment stream.** The lab has exactly one service
  (`demo-frontend`) and one environment (`lab`); nothing in this stage creates a stream
  named after either. `service`/`env`/`version` stay row-level fields inside `_rumdata`/
  `_rumlog`, exactly as Stage 8 already ingests them.
- **No custom/general-purpose telemetry stream.** `scripts/lab/streams/load-manifests.mjs`
  only ever knows about `rumdata`/`rumlog`; there is no code path that provisions any
  other stream name from a manifest.
- **Pipeline destination stays aligned.** The Stage 9 sanitization pipelines
  (`chicek_rumdata_sanitize_pipeline_v1` / `chicek_rumlog_sanitize_pipeline_v1`,
  `scripts/lab/provision-sanitization.mjs`) must still target exactly `_rumdata`/
  `_rumlog` — `pnpm lab:streams:verify` re-checks this on every run
  (`scripts/lab/streams/drift.js`'s `classifyPipelineDestination`,
  drift class `PIPELINE_DESTINATION_DRIFT`).

None of this changes Stage 8's RUM/browser-logs ingestion, Stage 9's sanitization, or
Stage 10's correlation behavior — Stage 15 only reads settings/schema and writes the
narrow, pre-validated settings subset described below.

## Manifests and schema contracts

```text
infrastructure/openobserve/streams/
  rumdata.stream.json             desired settings for _rumdata
  rumlog.stream.json              desired settings for _rumlog
  rumdata.schema-contract.json    required/conditional/controlled/forbidden field classes + known field types
  rumlog.schema-contract.json     (same, for _rumlog)
```

Each `*.stream.json` uses the real API's own field names inside `desiredSettings`
(`data_retention`, `max_query_range`, `store_original_data`, `full_text_search_keys`,
`index_fields`, `bloom_filter_fields`, `partition_keys`, `distinct_value_fields`) so a
manifest value can be diffed 1:1 against a live `GET .../schema` response. A declared
`volatileServerFields` list (`index_updated_at`, `approx_partition`,
`enable_log_patterns_extraction`, …) is excluded from every diff — these are
server-computed bookkeeping fields, not something this stage manages.

**Lab desired state** (verified writable/readable — capability audit #7/#8/#9/#10/#11):

```text
retention:            7 days
max query range:      168 hours
store_original_data:  false   (UDS)
full-text/index/bloom/partition/distinct-value fields: all empty (off)
```

**Production retention is `REQUIRED_COMPANY_DECISION`** — the 7-day lab value is never
treated as a production default anywhere in this stage's code, docs, or scripts.

Each `*.schema-contract.json` classifies every field Stage 15 knows about into:

```text
requiredNativeFields          present on every record of that stream (Stage 8-verified)
conditionalNativeFieldGroups  keyed by record type (view/action/error/resource/long_task/...)
controlledFields              chicek.* fields + test_run_id this repo itself produces
forbiddenFieldNames/Patterns  exact names + regexes (auth, cookie, token, secret,
                               private key, password, email, user identity, request/
                               response body — a superset of Stage 9's cleanup.vrl deletions)
forbiddenValuePatterns        value-level secret/credential signatures (same regex Stage
                               9's rum.vrl/rumlog.vrl already uses to drop events)
urlFieldsMustNotContainQueryOrFragment
knownFieldTypes               real Arrow type (Utf8/Int64/Boolean) per field, for
                               breaking-type-change detection
```

The contract deliberately does **not** freeze the native schema as a strict allow-list —
OpenObserve's own schema is additive-only and evolves with every new
`@openobserve/browser-rum`/`browser-logs` release (capability audit #5); a genuinely new,
harmless native field is expected and classified `SAFE_ADDITIVE_NATIVE_DRIFT`, not a
failure.

## Schema drift model

```text
NO_DRIFT                     nothing changed
SAFE_ADDITIVE_NATIVE_DRIFT   a small number of new, harmless native fields
BREAKING_SCHEMA_DRIFT        a required field went missing, a known field's type
                              changed, an uncontrolled chicek.* field appeared, or an
                              unbounded burst (> 10) of unknown fields appeared at once
SECURITY_DRIFT               a forbidden field/pattern/value appeared, a URL field
                              leaked a query string/fragment, or store_original_data
                              drifted to true on a canonical stream
SETTINGS_DRIFT                a managed settings field changed that isn't retention/
                              query-range/index/partition/UDS
RETENTION_DRIFT               data_retention or max_query_range drifted from desired
INDEX_DRIFT                   full_text_search_keys/index_fields/bloom_filter_fields/
                              partition_keys/distinct_value_fields drifted from desired
PIPELINE_DESTINATION_DRIFT    the sanitization pipeline no longer targets the canonical
                              stream it should
```

Classification is pure logic (`scripts/lab/streams/drift.js`,
`scripts/lab/streams/schema-contract.js`), 100%-covered by
`tests/lab/streams/*.test.js` (see [Test gate](#test-gate) below), and used identically
by both `pnpm lab:streams:verify` and `pnpm test:stage15:streams`. When more than one
drift class applies at once, the most severe one is reported as `overall`
(`SECURITY_DRIFT` > `BREAKING_SCHEMA_DRIFT` > `PIPELINE_DESTINATION_DRIFT` >
`RETENTION_DRIFT` > `INDEX_DRIFT` > `SETTINGS_DRIFT` > `SAFE_ADDITIVE_NATIVE_DRIFT` >
`NO_DRIFT`), and safe-additive drift is never auto-written back into the contract file —
a human reviews and updates the JSON deliberately.

**Why the cumulative stream schema alone can't be trusted**: no field-removal API was
found on this pinned build (capability audit #12/#13), and this repo's own probing found
no evidence OpenObserve ever prunes a field from a stream's schema once written — so a
field's presence in the schema list only proves it was _once_ produced, never that it
still is today. Capability audit #5 has the concrete, verified example: `_rumlog` carries
`_chicek_sanitization_policy` on every real record (set client-side by
`packages/browser-observability/src/sanitization/sanitizers/events.js` on every event),
but the same field never appears on a real `_rumdata` record — the vendor
`@openobserve/browser-rum` SDK serializes through its own fixed native event shape and
silently drops an added top-level key that isn't part of it, while
`@openobserve/browser-logs` preserves arbitrary extra keys as-is. Reading either stream's
schema list alone would never reveal this real, per-stream asymmetry. Because of this,
`BREAKING_SCHEMA_DRIFT`/`SECURITY_DRIFT` detection is always driven by a **fresh
canary record**, not the schema listing — the schema listing is only used for
`knownFieldTypes` type-change detection (§ [Test gate](#test-gate)'s Chromium/Firefox
canary).

## Stream commands

```bash
pnpm lab:streams:status     # read-only summary: exists, doc count, managed settings
pnpm lab:streams:dry-run    # normalized diff against the desired manifests — never writes
pnpm lab:streams:provision  # applies only pre-validated non-destructive changes
pnpm lab:streams:verify     # API read-back + settings/schema-type/pipeline drift + hash
```

Provisioning order (`scripts/lab/streams-provision.mjs`): read current → diff → refuse
anything not provably non-destructive
(`scripts/lab/streams/guard.js#isNonDestructiveSettingsChange` — only a `false` for
`store_original_data`, a non-negative integer for retention/query-range, or an _empty_
array for the index/partition fields ever qualifies) → apply → read-back → re-diff (must
be `NO_CHANGE`). Running `pnpm lab:streams:provision` twice in a row always produces
`NO_CHANGE` on the second run — this is asserted both manually (see the Gates list in the
roadmap task) and inside `pnpm test:stage15:streams` itself. Provisioning never performs a
type change, a field removal, a UDS/store-original enable, a canonical stream/data
delete, a breaking index migration, or writes an unsupported field — any manifest diff
that isn't one of the pre-approved non-destructive changes above is refused
(`REFUSED_NOT_PROVABLY_NON_DESTRUCTIVE`) rather than silently applied.

## Destructive guard and disposable lifecycle

`scripts/lab/streams/guard.js#validateDestructiveTarget` hard-blocks `_rumdata`/`_rumlog`
unconditionally — there is no confirmation flag or option that admits a canonical stream
into any destructive path (delete, or a settings value the guard doesn't recognize as
non-destructive). A non-canonical target is only ever admitted if its name matches the
exact `_chicek_lifecycle_test_<run-id>` shape, the org is the exact lab org (`default`),
and the caller passes `confirmed: true` explicitly. `pnpm test:stage15:streams` proves
this guard actually holds (not just that the pure function returns the right verdict) by
re-reading `_rumdata`/`_rumlog` after every guard check and confirming they still exist.

The disposable lifecycle gate (same script) runs entirely against one freshly-generated
`_chicek_lifecycle_test_*` stream per run:

```text
create (first JSON ingest)
  -> safe canary ingest (inert {message, level, run} payload — no PII/secret shape)
  -> schema/settings read-back
  -> supported setting apply (data_retention)
  -> second, idempotent apply (must produce the same read-back)
  -> supported deletion (whole-stream delete — capability audit #4)
  -> cleanup verification (post-delete read returns 404)
```

No canonical stream is ever used as the target of a destructive test. Where a listed gate
step has no real capability to exercise, this is reported honestly rather than faked: this
pinned OpenObserve build has no deletion job/status API at all (capability audit #13), so
there is nothing to bound-poll for a deletion job — the gate documents this gap instead of
fabricating a polling loop against a nonexistent endpoint.

## Real schema canary

`pnpm test:stage15:streams` drives the actual demo app through real Chromium **and**
Firefox (`@playwright/test`'s `chromium`/`firefox` launchers, matching Stage 8/9/10's own
browser-engine gate), producing genuine `@openobserve/browser-rum`/`browser-logs` SDK
output — not hand-crafted JSON — for: a view (automatic on load), a custom action, an
uncaught JS error, an unhandled rejection, a successful and a failing network resource
request, a browser log (fired automatically on first consent grant, same as Stage 8's
gate), and a best-effort long-task record.

Correlation is a **hybrid** of a unique run-id and a bounded time window, per the roadmap
task's own instruction to use both together: `recordAction`/`recordError`-driven events
(action/log records) carry a real `test_run_id` (`apps/demo-frontend/src/scenarios.js`'s
existing `testRunContext()`, gated on `globalThis.__CHICEK_TEST_RUN_ID__`, set via
Playwright's `context.addInitScript` before the page loads); native, fully
SDK-automatic events (the view, and the two window-level error/rejection listeners in
`apps/demo-frontend/src/App.jsx`, which do not route through `testRunContext()`) are
correlated by a tight bounded time window plus exact `service`/`env`/`version`/
`application_id` match instead, since the public API has no way to stamp an arbitrary
field onto a fully-native RUM event. This is a deliberate, documented limitation, not an
oversight — it does not weaken the schema-contract check itself, which runs identically
on every fetched record regardless of which correlation method found it.

Every fetched record (both browsers) is run through
`scripts/lab/streams/schema-contract.js#validateRecord` against the matching contract,
and the aggregate result through `classifyDrift()`; a `SECURITY_DRIFT` or
`BREAKING_SCHEMA_DRIFT` overall fails the gate. Real action records are additionally
checked for the Stage 10 correlation fields (`chicek_correlation_session_id`/
`chicek_correlation_epoch_id`), and `_rumreplay` is checked for zero records, exactly as
Stage 8's own gate already does.

## Index and partition decision

**Default result: no custom partition, no all-fields full-text index, no all-fields
secondary index, no distinct-values index.** All of `full_text_search_keys`,
`index_fields`, `bloom_filter_fields`, `partition_keys`, `distinct_value_fields` stay at
the server default (empty/off) in both manifests.

This is a decision to defer, not an oversight. The roadmap task is explicit that a real
index/partition change requires a _measured_ query-profile benefit against Stage 10's own
query templates (`infrastructure/openobserve/correlation/*.sql` — session/view timeline,
error-resource neighborhood, service/environment/version filtering), and this stage's lab
dataset (a handful of Playwright-driven canary runs) is far too small and short-lived to
produce a trustworthy `EXPLAIN`-level benchmark; fabricating one from an unrepresentative
dataset would be worse than not measuring at all. A real benchmark needs a
production-shaped data volume and query pattern this stage does not have — that
measurement, and any resulting index/partition change, is explicitly left to Stage 16
(Dashboard ve sorgular), which is the stage that will actually define and run the
representative query workload.

Two real, verified constraints future work must account for either way (capability audit
#7a): the settings-write shape for `full_text_search_keys`/`index_fields`/
`bloom_filter_fields` is a nested array (`[["field"]]`), not a flat string array despite
the read-back shape being flat; and a field cannot be both a full-text-search key and a
secondary index field at once (server-enforced `400`).

## Management-plane isolation

Browser-facing `https://localhost:8443` must never reach any stream/schema/settings/
delete/admin endpoint. This was true before Stage 15 (Stage 12's reverse-proxy
hardening — `infrastructure/docker/reverse-proxy/conf.d/ingestion.conf`'s `/api`/`/api/`
denial and `^/(_search|search|streams|users|organizations|dashboards|alerts|functions|
pipelines|rumtoken|source-map|replay)(/|$)` regex denial, plus `app.conf`'s
`^/(web|config|es|aws|gcp|otlp|prometheus|cloud|license|node)(/|$)` denial) and Stage 15
adds no new browser-facing route. `pnpm test:stage15:streams` re-verifies this on every
run against `/api/default/streams`, `/config`, `/api/default/rumtoken`,
`/api/default/_search`, and `/api/organizations` — all must fail with `>= 400` before
ever reaching OpenObserve.

Every Stage 15 operator command (`lab:streams:*`, `test:stage15:streams`) talks to
OpenObserve exclusively over its loopback-only-published admin port
(`http://127.0.0.1:5080`, already used by `scripts/lab/fetch-rum-token.mjs` and
`scripts/lab/provision-sanitization.mjs`) with the root Basic Auth credentials read once
from `.runtime/secrets/`, in-memory only, never logged, never written to a status/report
file, and never present in this repo, CI artifacts, or `nginx -T` output.

## Deletion, retention and identity — what this stage does and does not provide

```text
normal deletion            = retention/compactor (data_retention setting, background)
canonical emergency deletion = operator-only, whole-stream delete
                              (DELETE /api/{org}/streams/{stream} — capability audit #4);
                              never automated, never exposed as a script flag on a
                              canonical stream (the destructive guard hard-blocks it)
automated canonical delete = none — this stage never deletes _rumdata/_rumlog data itself
time-range deletion        = NOT_SUPPORTED_ON_PINNED_VERSION (capability audit #12) — no
                              real endpoint was found on this pinned OSS build
deletion job/status         = NOT_SUPPORTED_ON_PINNED_VERSION (capability audit #13) —
                              nothing to poll
user-specific deletion      = not supported — this platform has no user/session identity
                              model to delete by (Stage 4's threat model already excludes
                              real user identity; see docs/project-context.md)
backup                      = out of scope — backup/restore is Stage 20, and retention is
                              explicitly not a backup mechanism
```

If a real incident ever required removing already-ingested canonical data, the only
capability this pinned OpenObserve build actually offers is deleting the entire stream
(losing all history) or lowering `data_retention` and waiting for the background
compactor — there is no scoped, safe, automatable "delete these specific records" path on
this version, and this stage does not pretend otherwise.

## Test gate

```bash
pnpm test:stage15:streams
```

Runs, in order: a coverage-checked (`scripts/lab/streams/**` scoped to 100%
statements/branches/functions/lines — see `vitest.config.js`; this scoped include is
never folded into the default `pnpm test:coverage` include list, so the existing global
90%/85% thresholds and all other per-module 100% thresholds are unaffected) unit suite for
every pure module (`tests/lab/streams/*.test.js`); canonical settings/schema/pipeline
read-back and drift; provisioning idempotency; the canonical destructive guard;
the disposable lifecycle; management-plane isolation; and the real Chromium+Firefox
schema canary. A static-only test is not sufficient on its own — every check above that
can only be proven against a real, running OpenObserve v0.91.0 is a live check against
this repo's own lab, not a mock.

## Scope boundaries

Out of scope for this stage, unchanged: a dashboard or alert on top of these streams
(Stage 16/17), an SDK version upgrade, a custom gateway/backend, an OpenObserve
Collector, a production backup/restore procedure (Stage 20), and per-user identity
addition/deletion. Stage 11 (session replay) and Stage 13 (sampling/queue/retry
guarantee) remain `SECURITY BLOCKED / CLOSED BY DESIGN`, unchanged by this stage.
