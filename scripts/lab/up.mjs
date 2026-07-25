import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertExactLabToolchain,
  run,
  log,
  repoRoot,
  runDockerCompose,
  runtimeControlDaemonPidPath,
  sessionMetadataDaemonPidPath,
  stopDetachedProcess,
} from "./common.mjs";
import { fetchRealRumToken, persistRumToken } from "./fetch-rum-token.mjs";
import { generateRuntimeConfig } from "./generate-runtime-config.mjs";
import { generateRuntimeControl } from "./generate-runtime-control.mjs";
import { labInit } from "./init.mjs";
import { provisionDeliveryOpsToken } from "./provision-delivery-ops-token.mjs";
import { provisionSessionMetadataTokens } from "./provision-session-metadata-tokens.mjs";
import { provisionSanitization } from "./provision-sanitization.mjs";
import { runAllStaticChecks } from "./static-checks.mjs";
import { waitForHealthy } from "./wait.mjs";

const runtimeControlDaemonScript = fileURLToPath(
  new URL("./runtime-control-refresh-daemon.mjs", import.meta.url),
);
const sessionMetadataDaemonScript = fileURLToPath(
  new URL("./session-metadata-daemon.mjs", import.meta.url),
);

/**
 * Starts (or restarts) the detached background process that keeps
 * re-stamping runtime-control.json well inside its 10-minute TTL for as
 * long as the lab stays up — see runtime-control-refresh-daemon.mjs for
 * why this exists. Stops any daemon left over from a previous lab:up
 * first, so re-running lab:up without lab:down never accumulates orphans.
 */
function restartRuntimeControlDaemon() {
  stopDetachedProcess(runtimeControlDaemonPidPath);
  const child = spawn(process.execPath, [runtimeControlDaemonScript], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(runtimeControlDaemonPidPath, String(child.pid), { mode: 0o600 });
}

/**
 * Starts (or restarts) the detached background process that keeps
 * `_sessionreplay` populated with fresh, derived (non-recording) session
 * summary metadata so OpenObserve's native RUM -> Sessions page can render
 * a real session list — see sync-session-metadata.mjs for exactly what
 * this is and, just as importantly, what it deliberately is not.
 */
function restartSessionMetadataDaemon() {
  stopDetachedProcess(sessionMetadataDaemonPidPath);
  const child = spawn(process.execPath, [sessionMetadataDaemonScript], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(sessionMetadataDaemonPidPath, String(child.pid), { mode: 0o600 });
}

function checkToolchain() {
  const docker = run("docker", ["--version"], { capture: true, allowFailure: true });
  if (docker.status !== 0) {
    throw new Error("Docker Engine is not available on PATH.");
  }
  log(`  ${docker.stdout.trim()}`);

  const compose = run("docker", ["compose", "version"], { capture: true, allowFailure: true });
  if (compose.status !== 0) {
    throw new Error("Docker Compose v2 plugin ('docker compose') is not available.");
  }
  log(`  ${compose.stdout.trim()}`);
}

export async function labUp() {
  log("lab:up — checking toolchain...");
  checkToolchain();

  log("lab:up — running lab:init...");
  labInit();

  log("lab:up — static compose safety checks...");
  const staticResult = runAllStaticChecks();
  if (!staticResult.pass) {
    for (const finding of staticResult.findings) log(`  FAIL: ${finding}`);
    throw new Error("Static compose safety checks failed; refusing to start the lab.");
  }
  log("  static checks passed.");

  log("lab:up — building and starting containers...");
  runDockerCompose(["up", "-d", "--build"]);

  log("lab:up — waiting for all services to become healthy...");
  const waitResult = await waitForHealthy();
  if (!waitResult.healthy) {
    throw new Error("Not all services became healthy in time.");
  }

  log("lab:up — fetching the real server-side OpenObserve RUM ingest token...");
  const rumToken = await fetchRealRumToken();
  const persistResult = persistRumToken(rumToken);
  generateRuntimeConfig();
  log(
    `  OpenObserve ingest token: ${persistResult.changed ? "updated" : "already current"} ` +
      "(0600, value never printed); runtime config regenerated with browser-only token.",
  );

  if (persistResult.changed) {
    log(
      "lab:up — OpenObserve ingest token changed; recreating openobserve and telemetry-delivery-worker so both reflect it...",
    );
    // Compose does not treat a secret/bind-mounted *file's* content change as
    // a reason to recreate a service on its own (only a change to the
    // compose file's own definitions triggers that) — --force-recreate is
    // required for two independent reasons here:
    //   - openobserve: entrypoint.sh must re-read the now-corrected
    //     ZO_RUM_CLIENT_TOKEN secret file.
    //   - reverse-proxy: it bind-mounts runtime-config.json as a single
    //     file. Rewriting that file via atomic rename (a new inode at the
    //     same path) leaves an already-running container's bind mount
    //     pinned to the old inode's content — confirmed empirically, nginx
    //     kept serving the placeholder token until reverse-proxy itself was
    //     recreated. Regenerating runtime-config.json is the only thing
    //     that changes here (site/org/apiVersion/applicationId are static),
    //     so this only needs to happen when the token itself changed.
    runDockerCompose([
      "up",
      "-d",
      "--force-recreate",
      "openobserve",
      "alert-sink",
      "telemetry-delivery-worker",
    ]);
    const rumWaitResult = await waitForHealthy({
      services: ["openobserve", "alert-sink", "telemetry-delivery-worker"],
    });
    if (!rumWaitResult.healthy) {
      throw new Error(
        "openobserve/alert-sink/telemetry-delivery-worker did not become healthy again after the OpenObserve ingest token refresh.",
      );
    }
  }

  log("lab:up — provisioning dedicated OpenObserve delivery-ops ingestion token...");
  const opsTokenResult = await provisionDeliveryOpsToken();
  log(
    `  delivery ops token: ${opsTokenResult.changed ? "updated" : "already current"} ` +
      "(org ingestion token, 0600, value never printed).",
  );
  if (opsTokenResult.changed) {
    log(
      "lab:up — delivery ops token changed; recreating telemetry-delivery-worker so it re-reads the secret...",
    );
    runDockerCompose(["up", "-d", "--force-recreate", "telemetry-delivery-worker"]);
    const opsWaitResult = await waitForHealthy({
      services: ["telemetry-delivery-worker"],
      timeoutMs: 90_000,
    });
    if (!opsWaitResult.healthy) {
      throw new Error(
        "telemetry-delivery-worker did not become healthy after delivery ops token refresh.",
      );
    }
  }

  log("lab:up — provisioning dedicated OpenObserve session metadata service accounts...");
  const sessionTokenResult = await provisionSessionMetadataTokens();
  log(
    `  session metadata tokens: ${sessionTokenResult.changed ? "updated" : "already current"} ` +
      "(service-account credentials, 0600, values never printed).",
  );
  if (sessionTokenResult.changed) {
    log(
      "lab:up — session metadata tokens changed; recreating session-metadata-sync so it re-reads the secrets...",
    );
    runDockerCompose(["up", "-d", "--force-recreate", "session-metadata-sync"]);
    const sessionWaitResult = await waitForHealthy({
      services: ["session-metadata-sync"],
      timeoutMs: 90_000,
    });
    if (!sessionWaitResult.healthy) {
      throw new Error(
        "session-metadata-sync did not become healthy after session metadata token refresh.",
      );
    }
  }

  log("lab:up — provisioning OpenObserve telemetry sanitization backstop...");
  const sanitizationResult = await provisionSanitization();
  if (!sanitizationResult.pass) {
    for (const finding of sanitizationResult.findings) log(`  FAIL: ${finding}`);
    throw new Error("OpenObserve sanitization backstop could not be provisioned.");
  }

  // Republish the runtime-control document last, right before handing back
  // to the caller: its issuedAt/expiresAt window (max 10 minutes) is
  // deliberately short, so re-stamping it as the very last step maximizes
  // how much of that window is left for whatever runs against the lab next.
  generateRuntimeControl({ killSwitch: { active: false, reasonCode: "none" } });
  log("  runtime control: re-stamped with a fresh issuedAt/expiresAt window.");

  restartRuntimeControlDaemon();
  log(
    "  runtime control: refresh daemon (re-)started — keeps the document " +
      "inside its 10-minute TTL for as long as the lab stays up.",
  );

  restartSessionMetadataDaemon();
  log(
    "  session metadata: sync daemon (re-)started — keeps _sessionreplay " +
      "populated with derived (non-recording) session summaries so the " +
      "native RUM Sessions page can render a real list.",
  );

  log("lab:up complete. Demo: https://localhost:8443  OpenObserve UI: http://localhost:5080");
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:up");
    await labUp();
  } catch (error) {
    process.stderr.write(`lab:up FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
