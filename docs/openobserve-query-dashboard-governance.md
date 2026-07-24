# OpenObserve Query and Dashboard Governance (Stage 16)

This document explains the Stage 16 analytics layer: the metric/query catalog, the four starter
dashboards, and the install/status/audit/export/import/backup/restore tooling in
`scripts/lab/dashboards-*.mjs`. It assumes [`docs/openobserve-v0.91-dashboard-capabilities.md`](openobserve-v0.91-dashboard-capabilities.md)
(the real, pinned-API capability audit every design decision below is derived from) and
[`docs/openobserve-stream-schema-lifecycle.md`](openobserve-stream-schema-lifecycle.md) (Stage 15,
which already governs the two canonical streams `_rumdata`/`_rumlog` this stage only ever reads).

## Ownership model

```text
Stream/schema/privacy/query security → owned by this repo (Stage 9/10/15/16), system-managed
Starter dashboards                   → an initial-setup template, not a managed/immutable artifact
Company dashboards                   → owned entirely by the company via the OpenObserve UI
UI changes                           → never auto-overwritten or auto-written to Git
```

Nothing in this stage claims to "manage" a dashboard the way Stage 15 manages `_rumdata`/`_rumlog`'s
settings. A starter dashboard is created once (if missing) and then left alone; a company-owned
dashboard is never read as anything other than "some dashboard in some folder" by any Stage 16
tool except the read-only auditor.

## Metric catalog and query catalog

`infrastructure/openobserve/analytics/metric-catalog.json` documents 12 metrics: sessions,
views, session-error rate, errors per 1000 views, resource failure rate, browser log counts by
level, three Web Vital (LCP/CLS/INP) percentile-plus-sample-count metrics, two telemetry-freshness
metrics (one per canonical stream), and a per-version session/error comparison. Every metric names
exactly one query manifest (`queryId`) in `infrastructure/openobserve/analytics/queries/` — the
catalog documents the metric's _meaning and safety contract_; the query manifest documents the SQL
that computes it. `scripts/lab/dashboards/metric-catalog.js` validates the catalog's shape and
cross-references every `queryId` against the real query catalog.

Each of the 27 query manifests declares: `queryClass` (`OVERVIEW` — single-row aggregate,
`TABLE` — grouped/bounded, `LIST` — bounded raw rows, or `DRILLDOWN` — exact-id scoped),
`requiredVariables`/`optionalVariables`/`drilldownVariables`, `timeRangeCeilingHours` (always
≤168), `rowLimit`, `timeoutBudgetMs`, `expectedColumns`, `emptyDataSemantics`, `cardinalityClass`,
and `hasDivisionGuard`. `scripts/lab/dashboards/query-manifest.js` statically enforces, for every
manifest in the catalog:

- an explicit field list on `OVERVIEW`/`TABLE`/`LIST` queries (`SELECT *` is refused there; it is
  only permitted on `DRILLDOWN` queries, which are exact-id scoped and bounded by a `LIMIT`);
- `service`+`environment` required on every non-drilldown query;
- `GROUP BY`/`ORDER BY`/`LIMIT` on every `TABLE`/`LIST` query;
- no `GROUP BY` on a high-cardinality field (`session_id`, `view_id`, `action_id`, `resource_id`,
  `error_id`, `resource_url`, `view_url`, `error_message`, `error_stack`, `_timestamp`, `ip`, ...);
- a `CASE ... NULL` division guard on every `hasDivisionGuard:true` query;
- only a fixed, closed set of `{{placeholder}}` tokens (every manifest's own declared variables) —
  an unrecognized token is a hard validation failure, so a query can never silently interpolate
  something the catalog didn't declare;
- no statement separator (`;`) or SQL comment marker (`--`, `/*`) in the template text.

`scripts/lab/dashboards/sql-template.js` renders a manifest's template against real variables: every
string value is validated against a fixed safe charset and single-quote-escaped before
substitution — this is the only place caller-supplied values ever reach a SQL string, and it never
accepts free-form/raw text. `LIMIT` values are never caller-controlled — they are baked into the
template text at authoring time. Bounded time ranges are **not** embedded in the SQL text at all:
`start_time`/`end_time` are request-envelope parameters (exactly how OpenObserve's own dashboard
time-picker and `_search` API already work — see capability doc #12/#15), always supplied by the
caller and always ≤ the manifest's declared `timeRangeCeilingHours`. The ceiling is additionally
enforced mechanically at the stream level already: `_rumdata`/`_rumlog` both have
`max_query_range: 168` (Stage 15), so any query against them is silently clamped by OpenObserve
itself even if a caller asked for more.

## Empty-data semantics

Three states are always kept distinct and never conflated:

- **A real zero** — e.g. `count(*)` with zero matching rows still returns `200` with one row,
  `{"c": 0}`. This is not "no data"; it is a legitimate answer.
- **`NO_DATA`** — a ratio metric's denominator is 0. Every ratio query guards this with
  `CASE WHEN denominator = 0 THEN NULL ELSE ... END`, so the SQL result is a real `NULL`, not a `0`
  and not a fabricated ratio. Callers must render a `NULL` ratio as `NO_DATA`, never as `0`.
- **A query error** — a non-`200` `_search` response (bad SQL, a real backend error). Never
  silently coerced to `0` or `NO_DATA` by any Stage 16 tool; `scripts/lab/dashboards/audit.js`
  surfaces a supplied execution failure as its own `QUERY_RISK` finding.

## Starter dashboards

`infrastructure/openobserve/analytics/dashboards/*.dashboard.json` are **initial-setup templates**,
not managed/immutable artifacts:

- **Frontend Operations** — sessions, views, session-error rate, errors/1000 views, resource
  failure rate, telemetry freshness (both streams), browser log levels, error/resource/long-task
  trends, and a version distribution table.
- **Error Analysis** — top error classifications (by `error_type`/`error_source_type`, never by
  the high-cardinality `error_message`), browser and version breakdowns, an error trend, and a
  bounded (`LIMIT 20`) recent-errors detail table with a `session_id` column for manual drill-down
  into the Session Investigation dashboard.
- **Performance and Resources** — LCP/CLS/INP percentiles with sample counts, LCP by browser
  family, a long-task trend, and resource failure/latency breakdowns by `resource_type`.
- **Session Investigation** — a **Recent sessions** tab (a bounded `LIMIT 50`, most-recent-first
  `recent-sessions-list` table of real `view` events — `session_id`/`view_url` shown only as list
  columns, never grouped on, exactly like Error Analysis's own `recent-errors-detail`) for finding
  a session to look at, plus a **Session records** tab with session summary, views/actions, errors,
  resources, and browser logs, all scoped to exactly one `session_id` (a dashboard `constant`
  variable) once you've copied one in. No overview/group-by ever uses a session/view/action ID.
  **No Session Replay panel or replay link exists anywhere, and no panel here ever queries
  `_sessionreplay`** — Session Replay is Security Blocked (Stage 11). This dashboard was added
  before OpenObserve's own native RUM → Sessions page could list anything at all (it needs
  `_sessionreplay` populated too — see `docs/openobserve-v0.91-dashboard-capabilities.md`
  finding #21 and `docs/session-replay-security-decision.md`, now resolved by a separate
  metadata-only sync daemon); it remains a `_rumdata`-only alternative with zero
  `_sessionreplay` dependency, useful on its own merits even now that the native page also
  works.

Every starter panel's SQL is the query catalog's own template, rendered once at install time with
this lab's real `service`/`environment` values (capability doc #12: a panel's stored SQL is exactly
what `_search` executes, independently verified). A dashboard-level `session_id` "constant"
variable is declared for the Session Investigation dashboard, and its drill-down panels reference
it via OpenObserve's own `$session_id` token
(`scripts/lab/dashboards/sql-template.js`'s `DashboardVariableToken`) — but whether OpenObserve's
own web UI actually substitutes `$name` tokens before running a panel query was **not**
independently verified against the pinned build by this stage (capability doc #13/#13a: that
substitution happens inside OpenObserve's own frontend, not through any API this stage's scripts
can drive without a browser). This is stated plainly in the dashboard's own description; nothing
in Stage 16 depends on that behavior working for its own acceptance gate.

No panel ever uses a custom-JavaScript chart type, and no panel/description ever claims a
guaranteed-delivery/storage/purge property (Stage 13 remains Security Blocked; this stage adds no
delivery guarantee).

### Route breakdown is not supported on the pinned schema

The roadmap asked for a per-route breakdown alongside browser/version. No low-cardinality
"route"/"normalized route" field exists on `_rumdata` (only the raw, high-cardinality `view_url` —
see `infrastructure/openobserve/streams/rumdata.schema-contract.json`). Deriving one would require
a new Stage 9 pipeline transform, which is out of this stage's scope (roadmap: no new
stream/index/partition, no pipeline changes). Route is therefore only ever usable as an **optional,
exact-match filter** on `view_url`, never an overview/table grouping dimension — this is a
documented, honest gap, not an oversight.

## Stable identity: markers, not dashboardIds

`dashboardId` and `folderId` are always server-assigned on this pinned build (capability #7/#2) —
a client-supplied id is silently ignored on create. Stage 16 cannot pin a starter's identity to
its id the way Stage 15 pins a stream by name. Instead, `scripts/lab/dashboards/marker.js` embeds
a fixed string, `[chicek:starter:<starterId>:v<version>]`, in the dashboard's `description` field
at create time. Every install/status/audit/restore operation resolves identity from this marker,
never from the (unstable, environment-specific) `dashboardId`. Panel `id`s, by contrast, **are**
fully client-controlled and stable (capability #9b) — every starter panel has a fixed,
human-readable id.

### install-starters, and why a deleted starter is not resurrected

Dashboard titles are **not** unique on this pinned build (capability #7) — the server will happily
create two dashboards with the same title. `install-starters` therefore always lists the target
folder first and decides per starter:

1. A dashboard with a matching marker (same `starterId`) exists → `NO_CHANGE_ALREADY_INSTALLED` if
   the marker's version matches, or `SKIP_INSTALLED_DIFFERENT_VERSION` (never auto-upgraded) if not.
2. No marker match, but this repo's own local install-state record
   (`.runtime/generated/dashboard-install-state.json`, gitignored) says this starter was
   successfully created before → `SKIP_PREVIOUSLY_DELETED_BY_COMPANY`. This is the only way to
   tell "never installed" apart from "installed once, then the company deleted it" — OpenObserve
   itself keeps no tombstone for a deleted dashboard, so without this local record a normal
   install run could not make that distinction and would end up silently resurrecting a company's
   deliberate deletion.
3. No marker match, but an _unmanaged_ dashboard already uses the exact desired title → `SKIP_TITLE_COLLISION_UNMANAGED`
   (never assumes ownership of something it didn't create).
4. Otherwise → `CREATE`.

`install-starters` never overwrites, never deletes, and a second run against an unchanged
environment is `NO_CHANGE_ALREADY_INSTALLED` for every starter.

### restore-starters — the one destructive, explicit exception

`pnpm lab:dashboards:restore-starters --confirm` deletes the existing marker-managed copy of every
starter (only ever one whose own marker matches — never an unmanaged/company dashboard, even one
with a colliding title) and recreates it fresh from the current repo manifest. It refuses to run
without `--confirm`, and it is never invoked by `install-starters`, `lab:up`, `lab:verify`, or any
other normal provision/verify chain.

## Company dashboards

The company may create, edit, and delete dashboards freely from the OpenObserve UI. Stage 16:

- never modifies a company dashboard;
- never recreates a dashboard the company deleted (starter or not);
- never auto-writes a UI change back into this repo's Git history — `export`/`backup` only ever
  write to `.runtime/generated/` (gitignored), and never touch
  `infrastructure/openobserve/analytics/dashboards/*.dashboard.json` themselves;
- never resets a starter dashboard during a normal `install-starters`/`lab:up`/`lab:verify` run.

## Export, import, backup

- **`pnpm lab:dashboards:export`** — read-back (never a cached copy) of every dashboard in every
  folder, normalized (`scripts/lab/dashboards/normalize.js` strips `dashboardId`/`owner`/`created`/
  `hash`/`updatedAt` and the list view's flattened convenience fields — none of them are portable
  across environments, and none are secrets) into `.runtime/generated/dashboard-export/<run>/`,
  plus a per-starter panel-count diff against the repo manifest (informational only). Never writes
  into the repo, never commits.
- **`pnpm lab:dashboards:backup`** — the same normalization, but a full snapshot of every dashboard
  (starter and company-owned) plus an index manifest, for disaster recovery. Also
  `.runtime/generated/`, also non-destructive.
- **`pnpm lab:dashboards:import [--apply] [--dir=...] [--folder=...] [--conflict-policy=skip|overwrite]`** —
  reads a directory of normalized dashboard JSON files (e.g. from `export`/`backup`) and
  validates + plans first: **dry-run is the default**, `--apply` is required to actually write.
  `--conflict-policy` defaults to `skip` — an existing title is left untouched unless the operator
  explicitly passes `overwrite`. A duplicate title within the same import batch, or an unrecognized
  conflict policy, is refused outright. Import never deletes anything.

No export/backup/import output ever contains an admin credential, a runtime secret, or a raw
ingested telemetry record — `scripts/lab/verify-stage16-dashboards.mjs` asserts this on every run
by scanning the generated files for the literal admin email/password values.

## Read-only dashboard audit

`pnpm lab:dashboards:audit` (`scripts/lab/dashboards-audit.mjs` + the pure
`scripts/lab/dashboards/audit.js`) walks every dashboard in every folder and classifies findings
into `PASS`, `WARNING`, `PRIVACY_RISK`, `SECURITY_RISK`, `QUERY_RISK`, `CARDINALITY_RISK`, or
`UNSUPPORTED_FEATURE`. It never mutates or deletes anything. Checks include: forbidden/raw
sensitive field names and credential-shaped patterns (mirroring
`infrastructure/openobserve/streams/*.schema-contract.json`'s own forbidden-field lists), Session
Replay references, guaranteed-delivery/storage/purge claims, SQL statement separators/comment
markers, `SELECT *` outside an exact-id drilldown, a missing `service`/`environment` filter, a
`GROUP BY` on a high-cardinality field, a non-aggregate query with no row `LIMIT`, a literal
`_timestamp` range wider than 168h, a custom-JavaScript chart panel type, and (when the caller
supplies live execution results) a query syntax/type mismatch.

The credential/replay/delivery-guarantee/injection-marker checks are scoped to actual panel **SQL
text only**, not dashboard/panel titles or descriptions — free-text governance prose is expected to
discuss "Session Replay" or use a semicolon in a sentence when explaining what is deliberately
_not_ included, and flagging that would be a false positive, not a real risk. Forbidden-field-_name_
checks (a title accidentally naming a sensitive field) still apply to all text.

"Invalid schema field" detection is intentionally scoped to the same forbidden-field-name checks
above, not full SQL parsing — attempting to detect an arbitrary "unknown" field name from raw SQL
text risks false positives on legitimate SQL syntax, and this stage prefers a narrower, reliable
check over a broader, noisy one.

## Cardinality and privacy

Low-cardinality overview fields (safe to `GROUP BY`/filter on in an overview/table query): `service`,
`environment`, `version`, `user_agent_user_agent_family` (browser family), `user_agent_os_family`,
`type` (event type), `status`/`level` (log level), `resource_type`. High-cardinality fields (bounded
drill-down only, `LIMIT`ed, never grouped on): `session_id`, `view_id`, `action_id`, `resource_id`,
`error_id`, `resource_url`, `view_url`, `error_message`, `error_stack`, `_timestamp`. The two
exceptions are the Error Analysis dashboard's `recent-errors-detail` list query and the Session
Investigation dashboard's `recent-sessions-list` list query, which show `session_id`/`error_message`
and `session_id`/`view_url` (respectively) as bounded (`LIMIT 20`/`LIMIT 50`, most-recent-first)
**list columns** — never grouped/aggregated on, and exactly the "bounded drill-down" use the
roadmap describes.

## 35-second SDK flush behavior

`scripts/lab/verify-stage16-dashboards.mjs`'s Chromium/Firefox canary waits the same real,
independently-measured ~35s the vendor `@openobserve/browser-rum`/`@openobserve/browser-logs` SDKs
take to flush a batch (established and justified in detail in
`scripts/lab/verify-stage15-streams.mjs`) before polling `_search` — this is not a guess or an
arbitrary timeout, and it is not re-derived here; it reuses Stage 15's own finding.

## Stage 17 alert-ready boundary

No alert is created, evaluated, or threshold-enforced by this stage. Every metric declares an
`alertReady` object with placeholder fields only: `measurement`, `windowPlaceholder`,
`minimumSampleSize`, `thresholdDirection`, `recoveryConditionPlaceholder`, `grouping`,
`ownerPlaceholder`, `runbookPlaceholder` — every `*Placeholder` field is a literal `"STAGE_17_TBD"`
string, not a real value. Threshold direction, recovery condition, and alarm ownership are
explicitly left for Stage 17 to decide.

## Out of scope (unchanged from the roadmap)

Alerts, notifications, incident workflow, new streams/indexes/partitions, custom JavaScript charts,
Session Replay, and any delivery guarantee remain out of scope for this stage — see
[`docs/session-replay-security-decision.md`](session-replay-security-decision.md) and
[`docs/telemetry-delivery-security-decision.md`](telemetry-delivery-security-decision.md).
