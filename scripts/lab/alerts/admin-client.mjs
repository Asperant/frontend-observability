// Thin I/O wrapper around OpenObserve's alerts admin API. Like
// scripts/lab/streams/admin-client.mjs and scripts/lab/dashboards/
// admin-client.mjs, this is pure I/O and not imported by any pure-logic
// unit test, so it never actually counts toward the "scripts/lab/alerts/**"
// 100% coverage gate in practice; its correctness is exercised live by
// scripts/lab/alerts-*.mjs and scripts/lab/verify-alerts.mjs.
import { runDockerCompose } from "../common.mjs";
import {
  OPENOBSERVE_ADMIN_URL,
  ORG_ID,
  readAdminAuthHeader,
  search,
} from "../streams/admin-client.mjs";

export { OPENOBSERVE_ADMIN_URL, ORG_ID, readAdminAuthHeader, search };

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

export async function listAlerts(auth, folderId = "default") {
  const response = await apiFetch(
    auth,
    `/api/v2/${ORG_ID}/alerts?sort_by=name&desc=false&name=&folder=${encodeURIComponent(folderId)}`,
  );
  return Array.isArray(response.body?.list) ? response.body.list : [];
}

export async function getAlert(auth, alertId, folderId = "default") {
  const response = await apiFetch(
    auth,
    `/api/v2/${ORG_ID}/alerts/${encodeURIComponent(alertId)}?folder=${encodeURIComponent(folderId)}`,
  );
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`GET alert failed with status ${response.status}.`);
  return response.body;
}

export async function createAlert(auth, alertBody, folderId = "default") {
  return apiFetch(auth, `/api/v2/${ORG_ID}/alerts?folder=${encodeURIComponent(folderId)}`, {
    method: "POST",
    body: JSON.stringify(alertBody),
  });
}

export async function updateAlert(auth, alertBody, folderId = "default") {
  return apiFetch(
    auth,
    `/api/v2/${ORG_ID}/alerts/${encodeURIComponent(alertBody.id)}?folder=${encodeURIComponent(folderId)}`,
    { method: "PUT", body: JSON.stringify(alertBody) },
  );
}

export async function deleteAlert(auth, alertId, folderId = "default") {
  const response = await apiFetch(
    auth,
    `/api/v2/${ORG_ID}/alerts/${encodeURIComponent(alertId)}?folder=${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
  return { ok: response.status === 200 || response.status === 404, status: response.status };
}

export async function triggerAlert(auth, alertId, folderId = "default") {
  return apiFetch(
    auth,
    `/api/v2/${ORG_ID}/alerts/${encodeURIComponent(alertId)}/trigger?folder=${encodeURIComponent(folderId)}`,
    { method: "PATCH" },
  );
}

export async function exportAlert(auth, alertId) {
  return apiFetch(auth, `/api/v2/${ORG_ID}/alerts/${encodeURIComponent(alertId)}/export`, {
    method: "POST",
  });
}

export async function listAlertHistory(auth, params = {}) {
  const searchParams = new URLSearchParams({
    from: String(params.from ?? 0),
    size: String(params.size ?? 50),
  });
  if (params.alertId) searchParams.set("alert_id", params.alertId);
  if (params.startTime) searchParams.set("start_time", String(params.startTime));
  if (params.endTime) searchParams.set("end_time", String(params.endTime));
  const response = await apiFetch(auth, `/api/v2/${ORG_ID}/alerts/history?${searchParams}`);
  return response.body ?? { total: 0, hits: [] };
}

export async function listTemplates(auth) {
  const response = await apiFetch(auth, `/api/${ORG_ID}/alerts/templates`);
  return Array.isArray(response.body) ? response.body : [];
}

export async function createTemplate(auth, template) {
  return apiFetch(auth, `/api/${ORG_ID}/alerts/templates`, {
    method: "POST",
    body: JSON.stringify({
      name: template.openObserveTemplateName,
      body: template.body,
      type: template.type,
      title: "",
    }),
  });
}

export async function updateTemplate(auth, template) {
  return apiFetch(
    auth,
    `/api/${ORG_ID}/alerts/templates/${encodeURIComponent(template.openObserveTemplateName)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: template.openObserveTemplateName,
        body: template.body,
        type: template.type,
        title: "",
      }),
    },
  );
}

export async function deleteTemplate(auth, name) {
  return apiFetch(auth, `/api/${ORG_ID}/alerts/templates/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function listDestinations(auth) {
  const response = await apiFetch(
    auth,
    `/api/${ORG_ID}/alerts/destinations?page_num=1&page_size=100&sort_by=name&desc=false&module=alert`,
  );
  return Array.isArray(response.body) ? response.body : [];
}

export async function createLocalDestination(auth, { name, templateName }) {
  return apiFetch(auth, `/api/${ORG_ID}/alerts/destinations?module=alert`, {
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

export async function testLocalDestination(auth, body) {
  return apiFetch(auth, `/api/${ORG_ID}/alerts/destinations/test`, {
    method: "POST",
    body: JSON.stringify({
      url: "http://127.0.0.1:4312/alert-sink",
      method: "post",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

export function alertSinkControl(path) {
  const result = runDockerCompose(
    [
      "exec",
      "-T",
      "alert-sink",
      "node",
      "-e",
      `fetch('http://127.0.0.1:4312/alert-sink/${path}', { method: '${path === "events" ? "GET" : "POST"}' }).then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(error => { console.error(error.message); process.exit(1); })`,
    ],
    { capture: true },
  );
  return JSON.parse(result.stdout.trim());
}
