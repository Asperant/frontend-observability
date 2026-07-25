import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { emailSecretPath, log, passwordSecretPath, runDockerCompose } from "./common.mjs";
import { requestHttp } from "./verify-http.mjs";
import { waitForHealthy } from "./wait.mjs";

const STREAM = "lab_canary";

function basicAuthHeader() {
  const email = readFileSync(emailSecretPath, "utf8");
  const password = readFileSync(passwordSecretPath, "utf8");
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

async function search(canaryId, authHeader) {
  const nowUs = Date.now() * 1000;
  const startUs = nowUs - 60 * 60 * 1_000_000;
  const response = await requestHttp("/api/default/_search?type=logs", {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: {
        sql: `select * from ${STREAM} where canary_id='${canaryId}'`,
        start_time: startUs,
        end_time: nowUs,
        size: 10,
      },
    }),
  });
  if (response.statusCode !== 200) return { found: false, statusCode: response.statusCode };
  const parsed = JSON.parse(response.body);
  return { found: (parsed.hits ?? []).some((hit) => hit.canary_id === canaryId), statusCode: 200 };
}

/**
 * alert-sink shares openobserve's network namespace (`network_mode:
 * service:openobserve`) and is cascade-restarted alongside it. Right after
 * openobserve's own healthcheck flips green, alert-sink's restart can still
 * be tearing down/rebuilding that shared namespace, which briefly resets
 * the host-mapped port and surfaces as a raw socket error rather than a
 * normal HTTP response. Retry a few times before treating it as real data
 * loss.
 */
async function searchWithRetry(canaryId, authHeader, { attempts = 5, delayMs = 1000 } = {}) {
  let lastResult = { found: false, statusCode: undefined };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastResult = await search(canaryId, authHeader);
      if (lastResult.found) return lastResult;
    } catch (error) {
      lastResult = { found: false, statusCode: undefined, error: error.message };
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return lastResult;
}

/**
 * Ingests a unique synthetic event via the loopback OpenObserve data port
 * (never through the browser-facing reverse proxy), confirms it is
 * searchable, restarts the openobserve container, and confirms the same
 * event survives the restart. Never logs the admin credential.
 */
export async function checkPersistence() {
  const findings = [];
  const canaryId = `reference-lab-canary-${randomUUID()}`;
  const authHeader = basicAuthHeader();

  const ingest = await requestHttp(`/api/default/${STREAM}/_json`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify([{ canary_id: canaryId, message: "lab-verify-persistence" }]),
  });
  if (ingest.statusCode !== 200) {
    findings.push(`Canary ingest failed with status ${ingest.statusCode}.`);
    return { pass: false, findings };
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const beforeRestart = await search(canaryId, authHeader);
  if (!beforeRestart.found) {
    findings.push("Canary event was not found by search immediately after ingest.");
    return { pass: false, findings };
  }

  log("  persistence: canary ingested and found; restarting openobserve...");
  runDockerCompose(["restart", "openobserve"]);
  // openobserve restart cascades to alert-sink (shared network namespace via
  // depends_on.openobserve.restart: true), so both must be healthy before
  // the shared namespace is considered stable.
  const waitResult = await waitForHealthy({
    services: ["openobserve", "alert-sink"],
    timeoutMs: 120_000,
  });
  if (!waitResult.healthy) {
    findings.push("openobserve/alert-sink did not become healthy again after restart.");
    return { pass: false, findings };
  }

  const afterRestart = await searchWithRetry(canaryId, authHeader);
  if (!afterRestart.found) {
    findings.push(
      "Canary event was NOT found after openobserve restart (persistence failed)." +
        (afterRestart.error ? ` Last error: ${afterRestart.error}` : ""),
    );
  }

  return { pass: findings.length === 0, findings };
}
