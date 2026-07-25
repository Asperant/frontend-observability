// Companion to logical-export.mjs: applies a captured logical export to a
// target OpenObserve environment. Idempotent by existence check (matches
// this module's only real use: restoring into a disposable recovery
// recovery target) — an object already present by name/id is left alone
// and reported NO_CHANGE; only a missing object is created. Running the
// same restore twice against the same target therefore yields NO_CHANGE on
// the second run, which is what recovery proof asserts.
//
// Secrets: destinations are restored only with a caller-supplied
// `destinationSecrets` map (`{ [destinationName]: { url } }`); a
// destination the caller does not supply a secret for is left unrestored
// and reported as `skipped-missing-secret` — fail-closed, never a guessed
// or default URL.
//
// Like logical-export.mjs, this uses its own local `apiFetch(baseUrl, ...)`
// rather than the admin-client modules, which hardcode the main lab's
// 127.0.0.1:5080 — this module always targets a disposable recovery
// recovery environment on its own port.
import { canonicalJson, DEFAULT_BASE_URL } from "./logical-export.mjs";

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

function normalizeCurrentStreamSettings(settings = {}) {
  return {
    partition_keys: settings.partition_keys ?? {},
    full_text_search_keys: [...(settings.full_text_search_keys ?? [])].sort(),
    index_fields: [...(settings.index_fields ?? [])].sort(),
    bloom_filter_fields: [...(settings.bloom_filter_fields ?? [])].sort(),
    distinct_value_fields: [...(settings.distinct_value_fields ?? [])].map((f) => f.name).sort(),
    data_retention: settings.data_retention,
    max_query_range: settings.max_query_range,
  };
}

// Streams are lazily created by OpenObserve on first ingest — there is no
// explicit "create stream" API (matches scripts/lab/streams-provision.mjs's
// own SKIPPED_STREAM_DOES_NOT_EXIST outcome). In the real recovery
// chain the cold data-volume restore always runs first and already brings
// the stream (and its real documents) into existence. When logical restore
// runs in isolation (no data volume — e.g. a pure round-trip hash-equality
// test, or a genuinely empty disposable target), a missing stream is lazily
// bootstrapped with a single throwaway record first — OpenObserve's alert
// create API 404s ("Stream ... not found") against a stream that has never
// been written to at all, live-verified during this closeout.
async function bootstrapStream(baseUrl, auth, streamName) {
  await apiFetch(baseUrl, auth, `/api/default/${streamName}/_json`, {
    method: "POST",
    body: JSON.stringify([
      { _timestamp: Date.now() * 1000, _bootstrap: "logical-restore-lazy-stream-create" },
    ]),
  });
}

async function restoreStreams(baseUrl, auth, streamObjects) {
  const results = [];
  for (const { id, normalized } of streamObjects) {
    let schemaResponse = await apiFetch(
      baseUrl,
      auth,
      `/api/default/streams/${id}/schema?type=logs`,
    );
    if (schemaResponse.status === 404) {
      await bootstrapStream(baseUrl, auth, id);
      schemaResponse = await apiFetch(baseUrl, auth, `/api/default/streams/${id}/schema?type=logs`);
    }
    const schema = schemaResponse.status === 404 ? null : schemaResponse.body;
    if (!schema) {
      results.push({ id, action: "SKIPPED_STREAM_DOES_NOT_EXIST" });
      continue;
    }

    const currentNames = (schema.settings?.distinct_value_fields ?? []).map((field) => field.name);
    const missingDistinctValueFields = normalized.settings.distinct_value_fields.filter(
      (name) => !currentNames.includes(name),
    );
    const currentComparable = normalizeCurrentStreamSettings(schema.settings);
    const desiredComparable = {
      ...currentComparable,
      partition_keys: normalized.settings.partition_keys,
      full_text_search_keys: normalized.settings.full_text_search_keys,
      index_fields: normalized.settings.index_fields,
      bloom_filter_fields: normalized.settings.bloom_filter_fields,
      data_retention: normalized.settings.data_retention,
      max_query_range: normalized.settings.max_query_range,
    };
    const settingsAlreadyMatch =
      canonicalJson(currentComparable) === canonicalJson(desiredComparable);

    if (settingsAlreadyMatch && missingDistinctValueFields.length === 0) {
      results.push({ id, action: "NO_CHANGE" });
      continue;
    }

    if (!settingsAlreadyMatch) {
      const response = await apiFetch(
        baseUrl,
        auth,
        `/api/default/streams/${id}/settings?type=logs`,
        {
          method: "PUT",
          body: JSON.stringify({
            partition_keys: normalized.settings.partition_keys,
            full_text_search_keys: normalized.settings.full_text_search_keys,
            index_fields: normalized.settings.index_fields,
            bloom_filter_fields: normalized.settings.bloom_filter_fields,
            data_retention: normalized.settings.data_retention,
            max_query_range: normalized.settings.max_query_range,
          }),
        },
      );
      if (response.status !== 200) {
        throw new Error(`restoreStreams: settings PUT for ${id} failed (${response.status})`);
      }
    }
    // distinct_value_fields is additive-only and a single PUT only ever
    // registers the first name in the array (docs/openobserve-v0.91-stream-
    // capabilities.md capability #11a) — each missing name needs its own
    // sequential one-element-nested-array call.
    for (const name of missingDistinctValueFields) {
      const added = await apiFetch(baseUrl, auth, `/api/default/streams/${id}/settings?type=logs`, {
        method: "PUT",
        body: JSON.stringify({ distinct_value_fields: [[name]] }),
      });
      if (added.status !== 200) {
        throw new Error(
          `restoreStreams: distinct_value_fields PUT for ${id}/${name} failed (${added.status})`,
        );
      }
    }
    results.push({ id, action: "CREATED" });
  }
  return results;
}

// Matches scripts/lab/provision-sanitization.mjs's own ensureFunction()
// exactly: there is no single-function GET endpoint (only list), and a
// create body needs `trans_type` — its absence was live-verified during
// this closeout to leave the function silently missing from a later list.
async function restoreFunctions(baseUrl, auth, functionObjects) {
  const existingResponse = await apiFetch(baseUrl, auth, "/api/default/functions");
  const existingNames = new Set(
    (Array.isArray(existingResponse.body)
      ? existingResponse.body
      : (existingResponse.body?.list ?? [])
    ).map((fn) => fn.name),
  );
  const results = [];
  for (const { id, normalized } of functionObjects) {
    if (existingNames.has(id)) {
      results.push({ id, action: "NO_CHANGE" });
      continue;
    }
    const create = await apiFetch(baseUrl, auth, "/api/default/functions", {
      method: "POST",
      body: JSON.stringify({ name: id, function: normalized.source, trans_type: 0 }),
    });
    if (![200, 201, 204].includes(create.status)) {
      throw new Error(
        `restoreFunctions: create ${id} failed (${create.status}): ${JSON.stringify(create.body)}`,
      );
    }
    results.push({ id, action: "CREATED" });
  }
  return results;
}

async function restorePipelines(baseUrl, auth, pipelineObjects) {
  const existing = await apiFetch(baseUrl, auth, "/api/default/pipelines");
  const existingNames = new Set(
    (existing.body?.list ?? existing.body ?? []).map((pipeline) => pipeline.name),
  );
  const results = [];
  for (const { id, normalized } of pipelineObjects) {
    if (existingNames.has(id)) {
      results.push({ id, action: "NO_CHANGE" });
      continue;
    }
    const create = await apiFetch(baseUrl, auth, "/api/default/pipelines", {
      method: "POST",
      body: JSON.stringify({
        name: id,
        enabled: normalized.enabled ?? true,
        kind: normalized.pipelineKind ?? "user",
        source: normalized.source ?? { source_type: "realtime" },
        nodes: normalized.nodes,
        edges: normalized.edges.map((edge) => ({
          id: `e${edge.source}-${edge.target}`,
          source: edge.source,
          target: edge.target,
        })),
        org: "default",
      }),
    });
    if (![200, 201, 204].includes(create.status)) {
      throw new Error(
        `restorePipelines: create ${id} failed (${create.status}): ${JSON.stringify(create.body)}`,
      );
    }
    results.push({ id, action: "CREATED" });
  }
  return results;
}

async function ensureFolder(baseUrl, auth, folderName) {
  if (!folderName || folderName === "default") return "default";
  const foldersResponse = await apiFetch(baseUrl, auth, "/api/v2/default/folders/dashboards");
  const folders = Array.isArray(foldersResponse.body?.list) ? foldersResponse.body.list : [];
  const existing = folders.find((folder) => folder.name === folderName);
  if (existing) return existing.folderId;
  const created = await apiFetch(baseUrl, auth, "/api/v2/default/folders/dashboards", {
    method: "POST",
    body: JSON.stringify({ name: folderName, description: "restored by logical-restore" }),
  });
  return created.body?.folderId;
}

function denormalizeForCreate(normalized, { owner, createdAt }) {
  return {
    version: normalized.version,
    dashboardId: "",
    title: normalized.title,
    description: normalized.description,
    role: normalized.role ?? "",
    owner,
    created: createdAt,
    tabs: normalized.tabs,
    variables: normalized.variables,
  };
}

async function restoreDashboards(baseUrl, auth, dashboardObjects, { owner }) {
  const results = [];
  const folderCache = new Map();
  for (const entry of dashboardObjects) {
    if (entry.normalized.kind === "dashboard-folder") continue;
    const { folderName, body } = entry.normalized;
    if (!folderCache.has(folderName)) {
      folderCache.set(folderName, await ensureFolder(baseUrl, auth, folderName));
    }
    const folderId = folderCache.get(folderName);
    const existingResponse = await apiFetch(
      baseUrl,
      auth,
      `/api/default/dashboards?folder=${encodeURIComponent(folderId)}`,
    );
    const existingList = Array.isArray(existingResponse.body?.dashboards)
      ? existingResponse.body.dashboards
      : [];
    const already = existingList.some((dashboard) => dashboard.title === body.title);
    if (already) {
      results.push({ id: entry.id, action: "NO_CHANGE" });
      continue;
    }
    const created = await apiFetch(
      baseUrl,
      auth,
      `/api/default/dashboards?folder=${encodeURIComponent(folderId)}`,
      {
        method: "POST",
        body: JSON.stringify(
          denormalizeForCreate(body, { owner, createdAt: new Date().toISOString() }),
        ),
      },
    );
    if (created.status !== 200) {
      throw new Error(`restoreDashboards: create "${entry.id}" failed (${created.status})`);
    }
    results.push({ id: entry.id, action: "CREATED" });
  }
  return results;
}

async function restoreAlerts(baseUrl, auth, alertObjects) {
  const existingResponse = await apiFetch(
    baseUrl,
    auth,
    "/api/v2/default/alerts?sort_by=name&desc=false&name=&folder=default",
  );
  const existingNames = new Set(
    (Array.isArray(existingResponse.body?.list) ? existingResponse.body.list : []).map(
      (alert) => alert.name,
    ),
  );
  const results = [];
  for (const { id, normalized } of alertObjects) {
    if (existingNames.has(id)) {
      results.push({ id, action: "NO_CHANGE" });
      continue;
    }
    const created = await apiFetch(baseUrl, auth, "/api/v2/default/alerts?folder=default", {
      method: "POST",
      body: JSON.stringify(normalized.body),
    });
    if (created.status !== 200) {
      throw new Error(
        `restoreAlerts: create "${id}" failed (${created.status}): ${JSON.stringify(created.body)}`,
      );
    }
    results.push({ id, action: "CREATED" });
  }
  return results;
}

async function restoreTemplates(baseUrl, auth, templateObjects) {
  const existingResponse = await apiFetch(baseUrl, auth, "/api/default/alerts/templates");
  const existingNames = new Set(
    (Array.isArray(existingResponse.body) ? existingResponse.body : []).map(
      (template) => template.name,
    ),
  );
  const results = [];
  for (const { id, normalized } of templateObjects) {
    if (existingNames.has(id)) {
      results.push({ id, action: "NO_CHANGE" });
      continue;
    }
    const created = await apiFetch(baseUrl, auth, "/api/default/alerts/templates", {
      method: "POST",
      body: JSON.stringify({ name: id, type: normalized.type, body: normalized.body, title: "" }),
    });
    if (created.status !== 200) {
      throw new Error(`restoreTemplates: create "${id}" failed (${created.status})`);
    }
    results.push({ id, action: "CREATED" });
  }
  return results;
}

async function restoreDestinations(baseUrl, auth, destinationObjects, destinationSecrets = {}) {
  const existingResponse = await apiFetch(
    baseUrl,
    auth,
    "/api/default/alerts/destinations?page_num=1&page_size=100&sort_by=name&desc=false&module=alert",
  );
  const existingNames = new Set(
    (Array.isArray(existingResponse.body) ? existingResponse.body : []).map(
      (destination) => destination.name,
    ),
  );
  const results = [];
  for (const { id } of destinationObjects) {
    if (existingNames.has(id)) {
      results.push({ id, action: "NO_CHANGE" });
      continue;
    }
    const secret = destinationSecrets[id];
    if (!secret?.url) {
      results.push({ id, action: "skipped-missing-secret" });
      continue;
    }
    const created = await apiFetch(baseUrl, auth, "/api/default/alerts/destinations?module=alert", {
      method: "POST",
      body: JSON.stringify({
        name: id,
        type: "http",
        url: secret.url,
        method: "post",
        template: secret.templateName,
        skip_tls_verify: false,
        headers: { "Content-Type": "application/json" },
        output_format: "json",
        destination_type_name: "webhook",
        metadata: { prebuilt_type: "webhook", lab_only: "true" },
      }),
    });
    results.push({
      id,
      action: created.status === 200 ? "CREATED" : "FAILED",
      status: created.status,
    });
  }
  return results;
}

export async function restoreLogicalControlPlane(
  auth,
  exported,
  { owner, destinationSecrets, baseUrl = DEFAULT_BASE_URL } = {},
) {
  // Order matters: alerts reference destinations by name, and destinations
  // reference templates by name — both must exist before an alert create
  // can succeed (live-verified: creating alerts first 404s with "Alert
  // template ... not found").
  const streams = await restoreStreams(baseUrl, auth, exported.groups.streams);
  const functions = await restoreFunctions(baseUrl, auth, exported.groups.functions);
  const pipelines = await restorePipelines(baseUrl, auth, exported.groups.pipelines);
  const dashboards = await restoreDashboards(baseUrl, auth, exported.groups.dashboards, { owner });
  const templates = await restoreTemplates(baseUrl, auth, exported.groups.templates);
  const destinations = await restoreDestinations(
    baseUrl,
    auth,
    exported.groups.destinations,
    destinationSecrets,
  );
  const alerts = await restoreAlerts(baseUrl, auth, exported.groups.alerts);
  const results = { streams, functions, pipelines, dashboards, templates, destinations, alerts };
  const allActions = Object.values(results).flat();
  return {
    results,
    allNoChange: allActions.every((entry) => entry.action === "NO_CHANGE"),
    anyCreated: allActions.some((entry) => entry.action === "CREATED"),
    anyFailed: allActions.some((entry) => entry.action === "FAILED"),
  };
}
