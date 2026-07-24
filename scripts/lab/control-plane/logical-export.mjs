// Stage 20 closeout: a real, full logical control-plane export/restore —
// object *definitions* (stream settings/schemas, functions, pipelines,
// dashboard folders/dashboards/panels/queries, alerts, templates,
// destinations), not the count-only inventory the prior Stage 20 proof
// produced. Every object and object-group gets a SHA-256 over its
// normalized (volatile-field-stripped) JSON, so two independent exports of
// the same real state hash identically and a real drift is detectable.
//
// Secrets are never exported: destinations are secret-free by construction
// in this project (local webhook, `headers: {"Content-Type": ...}` only —
// no Authorization/token header has ever been used here), but this module
// still redacts any header whose name is not an explicit non-secret
// allowlist entry and records what it redacted in a manifest, so a future
// destination that *does* carry a bearer token can never leak one silently.
//
// Deliberately uses its own local `apiFetch(baseUrl, ...)` rather than
// scripts/lab/{streams,dashboards,alerts}/admin-client.mjs, which all
// hardcode the canonical main lab's 127.0.0.1:5080 — this module is reused
// against disposable Stage 20 recovery targets on other ports
// (scripts/recovery/run-stage20-proof.mjs), so every request must go
// through the caller-supplied `baseUrl`.
import { createHash } from "node:crypto";

export const CANONICAL_STREAMS = Object.freeze(["_rumdata", "_rumlog", "_chicek_delivery_ops"]);
const NON_SECRET_HEADER_NAMES = new Set(["content-type", "accept"]);
export const DEFAULT_BASE_URL = "http://127.0.0.1:5080";

// Also drops any key whose value is exactly `null`. Live-verified during
// this closeout: a dashboard panel round-tripped through export -> restore
// -> re-export gained several server-added, always-null default fields
// (`vrlFunctionQuery`, `streamAlias`, `legends_position`, `base_map`,
// `map_view`) that were not present on the original, older object — the
// pinned OpenObserve build's own dashboard schema evolved to add these
// defaults, so a freshly (re)created object always carries them even
// though an older stored object does not. Pruning `null` keeps the
// semantic hash stable across that noise without hiding any real content
// (`null` is never itself meaningful data here — absence, not a value).
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== null)
        .sort()
        .map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

export function sha256Of(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function groupHash(objects) {
  return sha256Of(objects.map((object) => object.sha256).sort());
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

async function listStreams(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, "/api/default/streams");
  return Array.isArray(response.body?.list) ? response.body.list : [];
}

async function getStreamSchema(baseUrl, auth, streamName) {
  const response = await apiFetch(
    baseUrl,
    auth,
    `/api/default/streams/${streamName}/schema?type=logs`,
  );
  if (response.status === 404) return null;
  return response.body;
}

async function listPipelines(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, "/api/default/pipelines");
  if (Array.isArray(response.body?.list)) return response.body.list;
  if (Array.isArray(response.body)) return response.body;
  return [];
}

async function listFunctions(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, "/api/default/functions");
  if (Array.isArray(response.body?.list)) return response.body.list;
  if (Array.isArray(response.body)) return response.body;
  return [];
}

async function listFolders(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, "/api/v2/default/folders/dashboards");
  return Array.isArray(response.body?.list) ? response.body.list : [];
}

async function listDashboards(baseUrl, auth, folderId) {
  const response = await apiFetch(
    baseUrl,
    auth,
    `/api/default/dashboards?folder=${encodeURIComponent(folderId)}`,
  );
  return Array.isArray(response.body?.dashboards) ? response.body.dashboards : [];
}

async function getDashboard(baseUrl, auth, dashboardId, folderId) {
  const response = await apiFetch(
    baseUrl,
    auth,
    `/api/default/dashboards/${encodeURIComponent(dashboardId)}?folder=${encodeURIComponent(folderId)}`,
  );
  return response.body;
}

function extractDashboardBody(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("extractDashboardBody: expected a versioned dashboard envelope");
  }
  const preferred = Number.isInteger(envelope.version) ? envelope[`v${envelope.version}`] : null;
  if (preferred) return preferred;
  for (let version = 8; version >= 1; version -= 1) {
    const body = envelope[`v${version}`];
    if (body) return body;
  }
  throw new Error("extractDashboardBody: expected a populated dashboard body");
}

function normalizeDashboardBody(v3Body) {
  return {
    schemaVersion: 1,
    version: v3Body.version,
    title: v3Body.title,
    description: v3Body.description,
    role: v3Body.role ?? "",
    tabs: v3Body.tabs ?? [],
    variables: v3Body.variables ?? { list: [] },
  };
}

async function listAlerts(baseUrl, auth) {
  const response = await apiFetch(
    baseUrl,
    auth,
    "/api/v2/default/alerts?sort_by=name&desc=false&name=&folder=default",
  );
  return Array.isArray(response.body?.list) ? response.body.list : [];
}

async function getAlert(baseUrl, auth, alertId) {
  const response = await apiFetch(
    baseUrl,
    auth,
    `/api/v2/default/alerts/${encodeURIComponent(alertId)}?folder=default`,
  );
  return response.body;
}

function normalizeAlertExport(alert) {
  const copy = structuredClone(alert);
  delete copy.id;
  delete copy.uuid;
  delete copy.alert_id;
  delete copy.updated_at;
  delete copy.created_at;
  delete copy.last_triggered_at;
  if (copy.url) copy.url = "[redacted-runtime-url]";
  if (copy.headers) {
    copy.headers = Object.fromEntries(
      Object.keys(copy.headers).map((key) => [
        key,
        key.toLowerCase() === "content-type" ? copy.headers[key] : "[redacted]",
      ]),
    );
  }
  return copy;
}

async function listTemplates(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, "/api/default/alerts/templates");
  return Array.isArray(response.body) ? response.body : [];
}

async function listDestinations(baseUrl, auth) {
  const response = await apiFetch(
    baseUrl,
    auth,
    "/api/default/alerts/destinations?page_num=1&page_size=100&sort_by=name&desc=false&module=alert",
  );
  return Array.isArray(response.body) ? response.body : [];
}

function normalizeStreamSettings(settings = {}) {
  return {
    partition_keys: settings.partition_keys ?? {},
    full_text_search_keys: [...(settings.full_text_search_keys ?? [])].sort(),
    index_fields: [...(settings.index_fields ?? [])].sort(),
    bloom_filter_fields: [...(settings.bloom_filter_fields ?? [])].sort(),
    distinct_value_fields: [...(settings.distinct_value_fields ?? [])]
      .map((field) => field.name)
      .sort(),
    data_retention: settings.data_retention,
    max_query_range: settings.max_query_range,
    store_original_data: settings.store_original_data,
    index_original_data: settings.index_original_data,
    index_all_values: settings.index_all_values,
    enable_distinct_fields: settings.enable_distinct_fields,
  };
}

function normalizeSchemaFields(fields = []) {
  return [...fields]
    .map((field) => ({ name: field.name, type: field.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function exportStreams(baseUrl, auth) {
  const streams = await listStreams(baseUrl, auth);
  const objects = [];
  for (const name of CANONICAL_STREAMS) {
    const meta = streams.find((stream) => (stream.name ?? stream.stream_name) === name);
    const schema = await getStreamSchema(baseUrl, auth, name);
    // schemaFields is backed up for informational completeness but
    // deliberately excluded from the hashed/compared content: it is an
    // emergent property inferred from whatever documents have actually
    // been ingested (additive, append-only), not a restorable control-plane
    // *setting* — a disposable round-trip target that never ingests the
    // main lab's full historical data volume will always have a smaller
    // schema than the source, independent of whether restore itself is
    // correct (live-verified during this closeout: this was the first
    // real semantic-hash mismatch found, and it was never a restore bug).
    const schemaFields = normalizeSchemaFields(schema?.schema ?? []);
    const hashedContent = {
      kind: "stream",
      id: name,
      storageType: meta?.storage_type ?? schema?.storage_type ?? null,
      streamType: meta?.stream_type ?? schema?.stream_type ?? "logs",
      settings: normalizeStreamSettings(meta?.settings ?? {}),
    };
    objects.push({
      id: name,
      normalized: { ...hashedContent, schemaFields },
      sha256: sha256Of(hashedContent),
    });
  }
  return objects;
}

async function exportFunctions(baseUrl, auth) {
  const functions = await listFunctions(baseUrl, auth);
  return functions.map((fn) => {
    const normalized = {
      kind: "function",
      id: fn.name,
      source: fn.function ?? fn.vrl ?? fn.source ?? "",
      params: fn.params ?? "",
      transType: fn.transType ?? fn.trans_type ?? null,
    };
    return { id: fn.name, normalized, sha256: sha256Of(normalized) };
  });
}

// Keeps the node's full real shape (id, type, io_type, position, data) —
// an earlier version of this function kept only io_type/node_type/data and
// dropped `position`/top-level `type`/node `id`, which OpenObserve's real
// create API requires (live-verified: recreating from the trimmed shape
// left every restored pipeline invisible to a later list, with no error).
function normalizePipelineNode(node) {
  return sortDeep({
    id: node?.id ?? null,
    type: node?.type ?? null,
    io_type: node?.io_type ?? null,
    position: node?.position ?? { x: 0, y: 0 },
    data: node?.data ?? {},
  });
}

async function exportPipelines(baseUrl, auth) {
  const pipelines = await listPipelines(baseUrl, auth);
  return pipelines.map((pipeline) => {
    const normalized = {
      kind: "pipeline",
      id: pipeline.name,
      enabled: pipeline.enabled ?? true,
      pipelineKind: pipeline.kind ?? "user",
      source: pipeline.source ?? null,
      nodes: (pipeline.nodes ?? []).map(normalizePipelineNode),
      edges: (pipeline.edges ?? [])
        .map((edge) => ({ source: edge.source, target: edge.target }))
        .sort((a, b) => `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`)),
    };
    return { id: pipeline.name, normalized, sha256: sha256Of(normalized) };
  });
}

async function exportDashboards(baseUrl, auth) {
  const folders = await listFolders(baseUrl, auth);
  // The "default" folder is an implicit, always-present pseudo-folder (not
  // something a restore ever explicitly creates) and, per environment, may
  // or may not even appear in a `listFolders()` response depending on
  // whether it currently holds anything — excluded from the tracked
  // folder-kind objects entirely. Real folders are identified by their
  // portable `name`, never by `folderId` — `folderId` is a volatile,
  // server-assigned identifier that a fresh restore target always assigns
  // differently from the source (live-verified: using it as the object id
  // made every restore look like a permanent mismatch, independent of
  // whether the restore was actually correct).
  const realFolders = folders.filter((folder) => folder.folderId !== "default");
  const folderObjects = realFolders.map((folder) => ({
    id: `folder:${folder.name}`,
    normalized: { kind: "dashboard-folder", name: folder.name },
    sha256: sha256Of({ kind: "dashboard-folder", name: folder.name }),
  }));

  const dashboardObjects = [];
  for (const folder of folders) {
    const dashboards = await listDashboards(baseUrl, auth, folder.folderId);
    for (const summary of dashboards) {
      const dashboardId = summary.dashboard_id ?? summary.dashboardId;
      const envelope = await getDashboard(baseUrl, auth, dashboardId, folder.folderId);
      const body = extractDashboardBody(envelope);
      const normalized = {
        kind: "dashboard",
        id: `${folder.name}::${body.title}`,
        folderName: folder.name,
        body: normalizeDashboardBody(body),
      };
      dashboardObjects.push({ id: normalized.id, normalized, sha256: sha256Of(normalized) });
    }
  }
  return [...folderObjects, ...dashboardObjects];
}

async function exportAlerts(baseUrl, auth) {
  const alerts = await listAlerts(baseUrl, auth);
  const objects = [];
  for (const summary of alerts) {
    const alertId = summary.alert_id ?? summary.id;
    const full = await getAlert(baseUrl, auth, alertId);
    const normalized = { kind: "alert", id: summary.name, body: normalizeAlertExport(full) };
    objects.push({ id: summary.name, normalized, sha256: sha256Of(normalized) });
  }
  return objects;
}

async function exportTemplates(baseUrl, auth) {
  const templates = await listTemplates(baseUrl, auth);
  return templates.map((template) => {
    const normalized = {
      kind: "template",
      id: template.name,
      type: template.type,
      body: template.body,
    };
    return { id: template.name, normalized, sha256: sha256Of(normalized) };
  });
}

function redactDestinationHeaders(headers = {}) {
  const redactions = [];
  const safe = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (NON_SECRET_HEADER_NAMES.has(key.toLowerCase())) return [key, value];
      redactions.push(key);
      return [key, "[secret-reference:not-exported]"];
    }),
  );
  return { safe, redactions };
}

async function exportDestinations(baseUrl, auth) {
  const destinations = await listDestinations(baseUrl, auth);
  const objects = [];
  const secretManifest = [];
  for (const destination of destinations) {
    const { safe, redactions } = redactDestinationHeaders(destination.headers);
    const normalized = {
      kind: "destination",
      id: destination.name,
      type: destination.type,
      method: destination.method,
      template: destination.template,
      headers: safe,
      outputFormat: destination.output_format ?? destination.outputFormat ?? null,
      // url is treated as a secret reference, not exported verbatim: it is
      // environment-specific (points at this lab's own loopback alert-sink)
      // and, in a real company destination, may itself embed credentials.
      urlRequiresSecretReference: true,
    };
    objects.push({ id: destination.name, normalized, sha256: sha256Of(normalized) });
    secretManifest.push({
      destination: destination.name,
      requiredSecrets: ["url", ...redactions],
      note: "Not exported. Restore fails closed until the real url/secret headers are supplied out of band.",
    });
  }
  return { objects, secretManifest };
}

/**
 * Full logical control-plane export: every object's normalized definition
 * plus a SHA-256 per object and per object-group (never counts alone).
 */
export async function exportLogicalControlPlane(auth, baseUrl = DEFAULT_BASE_URL) {
  const [streams, functions, pipelines, dashboards, alerts, templates, destinationResult] =
    await Promise.all([
      exportStreams(baseUrl, auth),
      exportFunctions(baseUrl, auth),
      exportPipelines(baseUrl, auth),
      exportDashboards(baseUrl, auth),
      exportAlerts(baseUrl, auth),
      exportTemplates(baseUrl, auth),
      exportDestinations(baseUrl, auth),
    ]);

  const groups = {
    streams,
    functions,
    pipelines,
    dashboards,
    alerts,
    templates,
    destinations: destinationResult.objects,
  };

  for (const [groupName, objects] of Object.entries(groups)) {
    if (objects.length === 0) {
      throw new Error(
        `exportLogicalControlPlane: group "${groupName}" is empty — refusing to treat an empty export as success.`,
      );
    }
  }

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    groups,
    groupHashes: Object.fromEntries(
      Object.entries(groups).map(([name, objects]) => [name, groupHash(objects)]),
    ),
    overallHash: sha256Of(
      Object.fromEntries(
        Object.entries(groups).map(([name, objects]) => [name, groupHash(objects)]),
      ),
    ),
    secretManifest: destinationResult.secretManifest,
  };
}
