// Thin I/O wrapper around OpenObserve's admin API, reached only over its
// loopback-only published port (127.0.0.1:5080) with the lab's own root
// Basic Auth credentials — never through the public reverse proxy (see
// scripts/lab/fetch-rum-token.mjs's identical rationale). Every request
// shape here matches what was actually verified against the pinned
// v0.91.0 binary — see docs/openobserve-v0.91-stream-capabilities.md.
// This module is intentionally not unit-coverage-gated (it is pure I/O,
// mirroring scripts/lab/provision-sanitization.mjs's own admin-API
// helpers); its correctness is exercised by the live
// scripts/lab/streams-*.mjs commands and scripts/lab/verify-streams.mjs
// against the real lab.

import { readFileSync } from "node:fs";

import { emailSecretPath, passwordSecretPath } from "../common.mjs";

export const OPENOBSERVE_ADMIN_URL = "http://127.0.0.1:5080";
export const ORG_ID = "default";

export function readAdminAuthHeader() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

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

export async function listStreams(auth) {
  const response = await apiFetch(auth, `/api/${ORG_ID}/streams`);
  return Array.isArray(response.body?.list) ? response.body.list : [];
}

export async function getStreamSchema(auth, streamName, type = "logs") {
  const response = await apiFetch(auth, `/api/${ORG_ID}/streams/${streamName}/schema?type=${type}`);
  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error(`GET stream schema for ${streamName} failed with status ${response.status}.`);
  }
  return response.body;
}

export async function updateStreamSettings(auth, streamName, settingsPatch, type = "logs") {
  const response = await apiFetch(
    auth,
    `/api/${ORG_ID}/streams/${streamName}/settings?type=${type}`,
    {
      method: "PUT",
      body: JSON.stringify(settingsPatch),
    },
  );
  return { ok: response.status === 200, status: response.status, body: response.body };
}

export async function deleteStream(auth, streamName, type = "logs") {
  const response = await apiFetch(auth, `/api/${ORG_ID}/streams/${streamName}?type=${type}`, {
    method: "DELETE",
  });
  return { ok: response.status === 200 || response.status === 404, status: response.status };
}

export async function ingestJson(auth, streamName, records) {
  const response = await apiFetch(auth, `/api/${ORG_ID}/${streamName}/_json`, {
    method: "POST",
    body: JSON.stringify(records),
  });
  return { ok: response.status === 200, status: response.status, body: response.body };
}

export async function search(auth, sql, { startUs, endUs }) {
  const response = await apiFetch(auth, `/api/${ORG_ID}/_search?type=logs`, {
    method: "POST",
    body: JSON.stringify({ query: { sql, start_time: startUs, end_time: endUs } }),
  });
  return { status: response.status, hits: response.body?.hits ?? [], body: response.body };
}

export async function listPipelines(auth) {
  const response = await apiFetch(auth, `/api/${ORG_ID}/pipelines`);
  if (Array.isArray(response.body?.list)) return response.body.list;
  if (Array.isArray(response.body)) return response.body;
  return [];
}
