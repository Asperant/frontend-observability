import { existsSync, readFileSync } from "node:fs";

import {
  assertExactLabToolchain,
  atomicWriteFile,
  emailSecretPath,
  log,
  logError,
  openObserveDeliveryOpsIngestTokenSecretPath,
  passwordSecretPath,
} from "./common.mjs";

const OPENOBSERVE_ADMIN_BASE_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";
const TOKEN_NAME = "frontend_observability_delivery_ops";

function rootAuth() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

async function openObserveJson(path, { method = "GET", body } = {}) {
  const response = await fetch(`${OPENOBSERVE_ADMIN_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: rootAuth(),
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

async function readExistingToken() {
  const body = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens`);
  const token = body?.data?.find((entry) => entry?.name === TOKEN_NAME)?.token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function createToken() {
  const body = await openObserveJson(`/api/${ORG_ID}/ingestion-tokens`, {
    method: "POST",
    body: {
      name: TOKEN_NAME,
      description:
        "FRONTEND_OBSERVABILITY delivery operations aggregate ingestion only. Not a browser credential.",
    },
  });
  const token = body?.data?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("OpenObserve did not return an ingestion token for delivery operations.");
  }
  return token;
}

export async function provisionDeliveryOpsToken() {
  const token = (await readExistingToken()) ?? (await createToken());
  const existing = existsSync(openObserveDeliveryOpsIngestTokenSecretPath)
    ? readFileSync(openObserveDeliveryOpsIngestTokenSecretPath, "utf8").trim()
    : null;
  if (existing === token) return { changed: false, name: TOKEN_NAME };
  atomicWriteFile(openObserveDeliveryOpsIngestTokenSecretPath, token, { mode: 0o600 });
  return { changed: true, name: TOKEN_NAME };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:provision-delivery-ops-token");
    const result = await provisionDeliveryOpsToken();
    log(
      JSON.stringify(
        {
          schemaVersion: 1,
          tokenName: result.name,
          changed: result.changed,
          secretFile: "openobserve-delivery-ops-ingest-token",
          valuePrinted: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    logError(`lab:provision-delivery-ops-token FAILED: ${error.message}`);
    process.exit(1);
  }
}
