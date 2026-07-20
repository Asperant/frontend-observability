// Thin I/O wrapper around OpenObserve's dashboard/folder/query admin API,
// reached only over its loopback-only published port (127.0.0.1:5080) with
// the lab's own root Basic Auth credentials — never through the public
// reverse proxy (see scripts/lab/streams/admin-client.mjs's identical
// rationale, which this module reuses for auth/search rather than
// duplicating it). Every request shape here matches what was actually
// verified against the pinned v0.91.0 binary — see
// docs/openobserve-v0.91-dashboard-capabilities.md. This module is
// intentionally not unit-coverage-gated (it is pure I/O); its correctness is
// exercised by the live scripts/lab/dashboards-*.mjs commands and
// scripts/lab/verify-stage16-dashboards.mjs against the real lab.

import {
  OPENOBSERVE_ADMIN_URL,
  ORG_ID,
  ingestJson,
  readAdminAuthHeader,
  search,
} from "../streams/admin-client.mjs";

export { OPENOBSERVE_ADMIN_URL, ORG_ID, ingestJson, readAdminAuthHeader, search };

async function apiFetch(auth, path, options = {}) {
  const response = await fetch(`${OPENOBSERVE_ADMIN_URL}${path}`, {
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

export async function listFolders(auth) {
  const response = await apiFetch(auth, `/api/v2/${ORG_ID}/folders/dashboards`);
  return Array.isArray(response.body?.list) ? response.body.list : [];
}

export async function createFolder(auth, { name, description }) {
  return apiFetch(auth, `/api/v2/${ORG_ID}/folders/dashboards`, {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

export async function deleteFolder(auth, folderId) {
  const response = await apiFetch(auth, `/api/v2/${ORG_ID}/folders/dashboards/${folderId}`, {
    method: "DELETE",
  });
  return { ok: response.status === 200, status: response.status };
}

export async function listDashboards(auth, folderId) {
  const response = await apiFetch(
    auth,
    `/api/${ORG_ID}/dashboards?folder=${encodeURIComponent(folderId)}`,
  );
  return Array.isArray(response.body?.dashboards) ? response.body.dashboards : [];
}

export async function getDashboard(auth, dashboardId, folderId) {
  const response = await apiFetch(
    auth,
    `/api/${ORG_ID}/dashboards/${dashboardId}?folder=${encodeURIComponent(folderId)}`,
  );
  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error(`GET dashboard ${dashboardId} failed with status ${response.status}.`);
  }
  return response.body;
}

export async function createDashboard(auth, folderId, dashboardBody) {
  return apiFetch(auth, `/api/${ORG_ID}/dashboards?folder=${encodeURIComponent(folderId)}`, {
    method: "POST",
    body: JSON.stringify(dashboardBody),
  });
}

export async function updateDashboard(auth, dashboardId, folderId, dashboardBody, hash) {
  return apiFetch(
    auth,
    `/api/${ORG_ID}/dashboards/${dashboardId}?folder=${encodeURIComponent(folderId)}&hash=${encodeURIComponent(hash)}`,
    { method: "PUT", body: JSON.stringify(dashboardBody) },
  );
}

export async function deleteDashboard(auth, dashboardId, folderId) {
  const response = await apiFetch(
    auth,
    `/api/${ORG_ID}/dashboards/${dashboardId}?folder=${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
  return { ok: response.status === 200 || response.status === 404, status: response.status };
}
