// Real alert-evaluation proof, as opposed to the "test destination" shortcut
// (scripts/lab/alerts-test-notification.mjs, scripts/performance/lib/
// notification-probe-io.mjs) or the admin API's manual `PATCH .../trigger`
// endpoint (scripts/lab/alerts/admin-client.mjs's triggerAlert) — both of
// those unconditionally send a notification without ever checking the
// alert's own SQL threshold (live-verified during this stage's closeout:
// manually triggering an alert whose condition was provably false, e.g.
// `count(*) > 0` against a service name that does not exist, still produced
// a real webhook notification). Neither is evidence that OpenObserve's own
// scheduler evaluates a real condition against real data.
//
// This module instead creates a disposable alert scoped to real telemetry
// and lets OpenObserve's own scheduler (frequency-based, real cron loop —
// never manually triggered) evaluate it on its own schedule, in two phases:
//   1. QUIET-FIRST: the alert's SQL is bound to a marker literal that has
//      never been ingested and never will be. A real scheduled evaluation
//      correctly produces no notification — proving the gate does not
//      "always fire" (also ruled out live: a naturally-aged breaching
//      marker still matched its own customQuery SQL hours later, because a
//      customQuery alert's start_time/end_time bookkeeping does not
//      actually re-bound a WHERE clause that has no _timestamp predicate of
//      its own — so "wait for it to age out" is not a reliable way to
//      reach a quiet state here; a query that can never match is).
//   2. FIRING: the SAME alert's query is then updated (still customQuery,
//      still real SQL) to a marker that IS immediately ingested, and a
//      later real scheduled evaluation correctly does notify.
// Real Alert History rows (GET /api/v2/{org}/alerts/history) are collected
// as supporting evidence throughout.
//
// Deliberately does not import scripts/lab/{streams,alerts}/admin-client.mjs
// — both hardcode OPENOBSERVE_ADMIN_URL to the canonical main lab's
// 127.0.0.1:5080, which is correct for every other lab script (there is
// only ever one main lab) but wrong here: this module is reused against
// disposable Stage 20 recovery targets on other ports
// (scripts/recovery/run-stage20-proof.mjs), so every request must go
// through the caller-supplied `baseUrl`.
import { DEMO_IDENTITY } from "../../../apps/demo-frontend/src/identity.js";
import { loadAlertTemplates } from "./catalog.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiFetch(baseUrl, auth, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

async function listDestinations(baseUrl, auth) {
  const response = await apiFetch(
    baseUrl,
    auth,
    "/api/default/alerts/destinations?page_num=1&page_size=100&sort_by=name&desc=false&module=alert",
  );
  return Array.isArray(response.body) ? response.body : [];
}

async function createTemplate(baseUrl, auth, template) {
  return apiFetch(baseUrl, auth, "/api/default/alerts/templates", {
    method: "POST",
    body: JSON.stringify({
      name: template.openObserveTemplateName,
      body: template.body,
      type: template.type,
      title: "",
    }),
  });
}

async function deleteTemplate(baseUrl, auth, name) {
  return apiFetch(baseUrl, auth, `/api/default/alerts/templates/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

async function createLocalDestination(baseUrl, auth, { name, templateName }) {
  return apiFetch(baseUrl, auth, "/api/default/alerts/destinations?module=alert", {
    method: "POST",
    body: JSON.stringify({
      name,
      type: "http",
      url: "http://127.0.0.1:4312/alert-sink",
      method: "post",
      template: templateName,
      skip_tls_verify: false,
      headers: { "Content-Type": "application/json" },
      output_format: "json",
      destination_type_name: "webhook",
      metadata: { prebuilt_type: "webhook", lab_only: "true" },
    }),
  });
}

async function createAlert(baseUrl, auth, alertBody) {
  return apiFetch(baseUrl, auth, "/api/v2/default/alerts?folder=default", {
    method: "POST",
    body: JSON.stringify(alertBody),
  });
}

async function updateAlert(baseUrl, auth, alertBody) {
  return apiFetch(
    baseUrl,
    auth,
    `/api/v2/default/alerts/${encodeURIComponent(alertBody.id)}?folder=default`,
    {
      method: "PUT",
      body: JSON.stringify(alertBody),
    },
  );
}

async function deleteAlert(baseUrl, auth, alertId) {
  return apiFetch(
    baseUrl,
    auth,
    `/api/v2/default/alerts/${encodeURIComponent(alertId)}?folder=default`,
    {
      method: "DELETE",
    },
  );
}

async function listAlertHistory(baseUrl, auth, params = {}) {
  const searchParams = new URLSearchParams({
    from: String(params.from ?? 0),
    size: String(params.size ?? 50),
  });
  if (params.alertId) searchParams.set("alert_id", params.alertId);
  if (params.startTime) searchParams.set("start_time", String(params.startTime));
  if (params.endTime) searchParams.set("end_time", String(params.endTime));
  const response = await apiFetch(baseUrl, auth, `/api/v2/default/alerts/history?${searchParams}`);
  return response.body ?? { total: 0, hits: [] };
}

async function ingestJson(baseUrl, auth, streamName, records) {
  const response = await apiFetch(baseUrl, auth, `/api/default/${streamName}/_json`, {
    method: "POST",
    body: JSON.stringify(records),
  });
  return { ok: response.status === 200, status: response.status, body: response.body };
}

async function searchSql(baseUrl, auth, sql, { startUs, endUs }) {
  const response = await apiFetch(baseUrl, auth, "/api/default/_search?type=logs", {
    method: "POST",
    body: JSON.stringify({ query: { sql, start_time: startUs, end_time: endUs } }),
  });
  return { status: response.status, hits: response.body?.hits ?? [], body: response.body };
}

async function ensureDestination(baseUrl, auth) {
  const existing = (await listDestinations(baseUrl, auth)).find((dest) =>
    dest.name.includes("local-alert-sink"),
  );
  if (existing) return { name: existing.name, ephemeral: false };

  const [template] = loadAlertTemplates();
  const templateName = `real-eval-probe-${Date.now()}`;
  await createTemplate(baseUrl, auth, { ...template, openObserveTemplateName: templateName });
  const destName = `real-eval-probe-dest-${Date.now()}`;
  const created = await createLocalDestination(baseUrl, auth, { name: destName, templateName });
  if (created.status !== 200) {
    throw new Error(`real-evaluation-probe: failed to create destination (${created.status})`);
  }
  return { name: destName, ephemeral: true, templateName };
}

// Matches scripts/lab/alerts/alert-builder.js's buildCandidateSql exactly:
// OpenObserve's real trigger_condition.threshold/operator here compare the
// number of ROWS the query returns, not a value inside a returned row (a
// bare `count(*)` aggregate always returns exactly one row regardless of
// its value, so a naive `threshold:0, operator:">"` against that row's
// value can never gate anything — live-verified during this stage's
// closeout: it fired on every single evaluation, including ones bound to a
// marker that had never been ingested). A `having` clause is what actually
// makes the query itself return zero rows when not breaching and exactly
// one when breaching, matched here by `threshold: 1, operator: ">="`.
function queryCondition(service, environment, marker) {
  return {
    type: "sql",
    conditions: [],
    sql: `select count(*) as zo_sql_val from "_rumdata" where service = '${service}' and env = '${environment}' and marker = '${marker}' having count(*) > 0`,
    promql: "",
    promql_condition: null,
    vrl_function: null,
    multi_time_range: [],
    aggregation: null,
  };
}

function buildProbeAlertBody({ destinationName, service, environment, neverMatchMarker, runId }) {
  return {
    name: `real-eval-probe-${runId}`,
    stream_type: "logs",
    stream_name: "_rumdata",
    is_real_time: false,
    query_condition: queryCondition(service, environment, neverMatchMarker),
    trigger_condition: {
      period: 1,
      operator: ">=",
      frequency: 1,
      cron: "",
      threshold: 1,
      silence: 0,
      frequency_type: "minutes",
      timezone: "UTC",
      tolerance_in_secs: null,
    },
    destinations: [destinationName],
    context_attributes: {},
    enabled: true,
    description: `Stage 20 closeout real-evaluation probe — disposable, deleted by this same run. runId=${runId}`,
    folder_id: "default",
  };
}

/**
 * @param {object} params
 * @param {string} params.auth Basic auth header value
 * @param {string} [params.baseUrl] OpenObserve admin API base URL — defaults
 *   to the canonical main lab; pass a disposable recovery target's own
 *   `http://127.0.0.1:<port>` when reusing this against Stage 20 recovery
 *   environments.
 * @param {string} [params.service]
 * @param {string} [params.environment]
 * @param {number} [params.quietWindowMs] bound on waiting to confirm the
 *   real scheduler produces no notification for a condition that can never
 *   match
 * @param {number} [params.firingTimeoutMs] bound on waiting for the real
 *   scheduler to observe a genuinely breaching marker and notify
 * @param {(path: string) => any} params.alertSinkControl caller-supplied,
 *   since reaching the disposable/main alert-sink's control endpoint always
 *   shells out via `docker compose exec`, scoped to whichever project the
 *   caller is targeting.
 */
export async function runRealAlertEvaluationProbe({
  auth,
  baseUrl = "http://127.0.0.1:5080",
  service = DEMO_IDENTITY.service,
  environment = DEMO_IDENTITY.environment,
  quietWindowMs = 100_000,
  firingTimeoutMs = 150_000,
  pollIntervalMs = 5000,
  alertSinkControl,
  // Optional hook invoked with { alertId, alertName } after the firing
  // phase but before the disposable alert is deleted — lets a caller (e.g.
  // a Playwright test) visit the real native UI's Alert History panel for
  // this exact alert while it still exists.
  beforeCleanup,
}) {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const neverMatchMarker = `real-eval-never-${runId}`;
  const breachingMarker = `real-eval-breach-${runId}`;
  const destination = await ensureDestination(baseUrl, auth);
  alertSinkControl("reset");

  const create = await createAlert(
    baseUrl,
    auth,
    buildProbeAlertBody({
      destinationName: destination.name,
      service,
      environment,
      neverMatchMarker,
      runId,
    }),
  );
  if (create.status !== 200 || !create.body?.id) {
    throw new Error(
      `real-evaluation-probe: alert create failed (${create.status}): ${JSON.stringify(create.body)}`,
    );
  }
  const alertId = create.body.id;

  async function cleanup() {
    await deleteAlert(baseUrl, auth, alertId);
    if (destination.ephemeral) {
      await deleteTemplate(baseUrl, auth, destination.templateName);
    }
  }

  try {
    // Phase 1 (QUIET): the alert's query can, by construction, never match
    // any row. Wait a real, bounded window and confirm the real scheduler
    // never notifies.
    const quietStartMs = Date.now();
    await sleep(quietWindowMs);
    const eventsAfterQuietWindow = alertSinkControl("events").count;
    const quietCycleObserved = eventsAfterQuietWindow === 0;
    const historyDuringQuiet = await listAlertHistory(baseUrl, auth, {
      alertId,
      startTime: (quietStartMs - 10_000) * 1000,
      endTime: Date.now() * 1000,
    });

    // Phase 2 (FIRING): switch the same alert to a query bound to a marker
    // that is immediately, really ingested — then wait for the real
    // scheduler (never manually triggered) to notice and notify.
    const updated = {
      id: alertId,
      ...buildProbeAlertBody({
        destinationName: destination.name,
        service,
        environment,
        neverMatchMarker: breachingMarker,
        runId,
      }),
    };
    const upd = await updateAlert(baseUrl, auth, updated);
    if (upd.status !== 200) {
      throw new Error(
        `real-evaluation-probe: alert update to breaching query failed (${upd.status})`,
      );
    }

    const ingestResult = await ingestJson(baseUrl, auth, "_rumdata", [
      {
        _timestamp: Date.now() * 1000,
        service,
        env: environment,
        version: DEMO_IDENTITY.version,
        session_id: `real-eval-probe-session-${breachingMarker}`,
        view_id: `real-eval-probe-view-${breachingMarker}`,
        type: "view",
        marker: breachingMarker,
        message: `real evaluation probe marker ${breachingMarker}`,
        level: "info",
        error_type: "None",
        error_source_type: "real-eval-probe",
        view_loading_time: 1,
        view_largest_contentful_paint: 1000,
        view_interaction_to_next_paint: 50,
        view_cumulative_layout_shift: 0.01,
        resource_type: "fetch",
        resource_duration: 10,
        resource_status_code: 200,
        resource_url: "https://localhost:8443/real-eval-probe",
        action_target_name: "real-eval-probe",
      },
    ]);
    if (!ingestResult.ok) {
      throw new Error(`real-evaluation-probe: marker ingest failed (${ingestResult.status})`);
    }

    let markerVisible = false;
    for (let attempt = 0; attempt < 20 && !markerVisible; attempt += 1) {
      const { hits } = await searchSql(
        baseUrl,
        auth,
        `SELECT marker FROM "_rumdata" WHERE marker = '${breachingMarker}' LIMIT 1`,
        { startUs: (Date.now() - 3_600_000) * 1000, endUs: Date.now() * 1000 },
      );
      markerVisible = hits.length > 0;
      if (!markerVisible) await sleep(1000);
    }
    if (!markerVisible) {
      throw new Error("real-evaluation-probe: ingested breaching marker never became queryable");
    }

    const firingBaselineCount = alertSinkControl("events").count;
    const firingDeadlineMs = Date.now() + firingTimeoutMs;
    let firingObserved = false;
    let firingEventCount = firingBaselineCount;
    while (Date.now() < firingDeadlineMs && !firingObserved) {
      await sleep(pollIntervalMs);
      const events = alertSinkControl("events");
      firingEventCount = events.count;
      firingObserved = events.count > firingBaselineCount;
    }

    const historyAfterFiring = await listAlertHistory(baseUrl, auth, {
      alertId,
      startTime: (quietStartMs - 10_000) * 1000,
      endTime: Date.now() * 1000,
    });

    if (beforeCleanup) await beforeCleanup({ alertId, alertName: `real-eval-probe-${runId}` });

    return {
      alertId,
      quietCycleObserved,
      eventsAfterQuietWindow,
      historyRowCountDuringQuiet: historyDuringQuiet.total ?? 0,
      firingObserved,
      firingEventCount,
      historyRowCountFinal: historyAfterFiring.total ?? 0,
      historyHits: historyAfterFiring.hits ?? [],
    };
  } finally {
    await cleanup();
  }
}
