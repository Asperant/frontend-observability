import { existsSync, readFileSync } from "node:fs";

import {
  atomicWriteFile,
  emailSecretPath,
  openObserveRumIngestTokenSecretPath,
  passwordSecretPath,
} from "./common.mjs";

// openobserve's own management API, reached over its loopback-only
// published port (127.0.0.1:5080 — already exposed for the OpenObserve UI
// since Stage 6). Never proxied through the public reverse-proxy: the
// reverse-proxy's /api/ path is denied by design (see
// infrastructure/docker/reverse-proxy/conf.d/ingestion.conf), and this is a
// host-operator, root-credential admin call, not browser traffic.
const OPENOBSERVE_ADMIN_BASE_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";

/**
 * Fetches the real, server-generated RUM ingestion token for the root user
 * via `GET /api/{org}/rumtoken`. Confirmed by reading OpenObserve's own
 * source (src/api_management/src/auth/validator.rs, `validate_token` /
 * `users::get_user_by_token`): RUM/browser-logs ingestion authorizes the
 * `o2-api-key` query parameter against this specific, DB-backed per-user
 * token — an operator-chosen value (e.g. the ZO_RUM_CLIENT_TOKEN env var)
 * is never consulted for authorization, only for the `/config` endpoint's
 * display snippet. This call is idempotent: the same user always gets the
 * same token back.
 */
export async function fetchRealRumToken() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  const auth = Buffer.from(`${email}:${password}`).toString("base64");

  const response = await fetch(`${OPENOBSERVE_ADMIN_BASE_URL}/api/${ORG_ID}/rumtoken`, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    throw new Error(
      `GET /api/${ORG_ID}/rumtoken failed with status ${response.status} ${response.statusText}`,
    );
  }
  const body = await response.json();
  const token = body?.data?.rum_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("openobserve did not return a rum_token in /rumtoken response.");
  }
  return token;
}

/**
 * Writes `token` into the RUM client-token secret file, atomically and with
 * 0600 permissions, only if it differs from what is already stored.
 */
export function persistRumToken(token) {
  const existing = existsSync(openObserveRumIngestTokenSecretPath)
    ? readFileSync(openObserveRumIngestTokenSecretPath, "utf8").trim()
    : null;
  if (existing === token) {
    return { changed: false };
  }
  atomicWriteFile(openObserveRumIngestTokenSecretPath, token, { mode: 0o600 });
  return { changed: true };
}
