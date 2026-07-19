import { spawnSync } from "node:child_process";

import {
  composeArgs,
  dockerDir,
  dockerEnv,
  log,
  logError,
  redactSecrets,
  SERVICES,
  assertExactLabToolchain,
} from "./common.mjs";
import { getComposeStatus } from "./status.mjs";
import { passwordSecretPath, emailSecretPath } from "./common.mjs";
import { readFileSync, existsSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

function readSecretValuesForRedaction() {
  const values = [];
  for (const path of [emailSecretPath, passwordSecretPath]) {
    if (existsSync(path)) values.push(readFileSync(path, "utf8"));
  }
  return values;
}

function tailLogs(service, lines = 40) {
  const result = spawnSync("docker", composeArgs(["logs", "--tail", String(lines), service]), {
    cwd: dockerDir,
    env: dockerEnv(),
    encoding: "utf8",
  });
  return redactSecrets(
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    readSecretValuesForRedaction(),
  );
}

/**
 * Bounded, fixed-interval polling (no exponential backoff) for every
 * required service's Docker healthcheck to report healthy.
 */
export async function waitForHealthy({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = POLL_INTERVAL_MS,
  services = SERVICES,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = new Map();

  while (Date.now() < deadline) {
    const containers = getComposeStatus();
    const byService = new Map(containers.map((c) => [c.Service, c]));
    lastReport = byService;

    const notHealthy = services.filter((name) => byService.get(name)?.Health !== "healthy");
    log(
      `lab:wait — ${services.length - notHealthy.length}/${services.length} healthy ` +
        `(waiting on: ${notHealthy.join(", ") || "none"})`,
    );

    if (notHealthy.length === 0) {
      log("lab:wait — all services healthy.");
      return { healthy: true };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const stillWaiting = services.filter((name) => lastReport.get(name)?.Health !== "healthy");
  logError(`lab:wait TIMED OUT after ${timeoutMs}ms. Not healthy: ${stillWaiting.join(", ")}`);
  for (const service of stillWaiting) {
    logError(`\n--- last logs for ${service} (secrets redacted) ---`);
    logError(tailLogs(service));
  }
  return { healthy: false, stillWaiting };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:wait");
    const result = await waitForHealthy();
    if (!result.healthy) process.exit(1);
  } catch (error) {
    process.stderr.write(`lab:wait FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
