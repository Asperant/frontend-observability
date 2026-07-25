#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

import {
  assertExactLabToolchain,
  atomicWriteFile,
  emailSecretPath,
  log,
  logError,
  openObserveSessionReadTokenSecretPath,
  openObserveSessionWriteTokenSecretPath,
  passwordSecretPath,
} from "./common.mjs";

const OPENOBSERVE_ADMIN_BASE_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";
export const SESSION_METADATA_READ_USERNAME = "chicek-session-metadata-read@chicek-lab.invalid";
export const SESSION_METADATA_WRITE_USERNAME = "chicek-session-metadata-write@chicek-lab.invalid";

function rootAuth() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

function serviceAuth(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

async function openObserveJson(path, { method = "GET", body, auth = rootAuth() } = {}) {
  const response = await fetch(`${OPENOBSERVE_ADMIN_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 160)}`);
  }
  return text.length === 0 ? {} : JSON.parse(text);
}

async function existingServiceAccounts() {
  const body = await openObserveJson(`/api/${ORG_ID}/service_accounts`);
  return Array.isArray(body?.data) ? body.data : [];
}

async function authCanSearch(email, token) {
  if (!token) return false;
  const response = await fetch(`${OPENOBSERVE_ADMIN_BASE_URL}/api/${ORG_ID}/_search?type=logs`, {
    method: "POST",
    headers: {
      Authorization: serviceAuth(email, token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        sql: "select * from _rumdata limit 1",
        start_time: (Date.now() - 60_000) * 1000,
        end_time: Date.now() * 1000,
      },
    }),
  });
  return response.ok;
}

async function ensureServiceAccount({ email, tokenPath, firstName }) {
  const existingToken = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
  if (await authCanSearch(email, existingToken)) return { changed: false, email };

  const accounts = await existingServiceAccounts();
  if (accounts.some((account) => account.email === email)) {
    throw new Error(
      `service account ${email} exists but the local token file is not valid; rotate it with the operator token procedure or purge/recreate the lab secret.`,
    );
  }

  const body = await openObserveJson(`/api/${ORG_ID}/service_accounts`, {
    method: "POST",
    body: { email, first_name: firstName, last_name: "sync", role: "admin" },
  });
  const token = body?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`OpenObserve did not return a token for ${email}.`);
  }
  atomicWriteFile(tokenPath, token, { mode: 0o600 });
  return { changed: true, email };
}

export async function provisionSessionMetadataTokens() {
  const read = await ensureServiceAccount({
    email: SESSION_METADATA_READ_USERNAME,
    firstName: "session-metadata-read",
    tokenPath: openObserveSessionReadTokenSecretPath,
  });
  const write = await ensureServiceAccount({
    email: SESSION_METADATA_WRITE_USERNAME,
    firstName: "session-metadata-write",
    tokenPath: openObserveSessionWriteTokenSecretPath,
  });
  return { changed: read.changed || write.changed, read, write };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:provision-session-metadata-tokens");
    const result = await provisionSessionMetadataTokens();
    log(
      JSON.stringify(
        {
          schemaVersion: 1,
          changed: result.changed,
          readUser: result.read.email,
          writeUser: result.write.email,
          valuePrinted: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    logError(`lab:provision-session-metadata-tokens FAILED: ${error.message}`);
    process.exit(1);
  }
}
