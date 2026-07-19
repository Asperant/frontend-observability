import { assertExactLabToolchain, run, log, runDockerCompose } from "./common.mjs";
import { fetchRealRumToken, persistRumToken } from "./fetch-rum-token.mjs";
import { generateRuntimeConfig } from "./generate-runtime-config.mjs";
import { labInit } from "./init.mjs";
import { runAllStaticChecks } from "./static-checks.mjs";
import { waitForHealthy } from "./wait.mjs";

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

  log("lab:up — fetching the real OpenObserve RUM client token...");
  const rumToken = await fetchRealRumToken();
  const persistResult = persistRumToken(rumToken);
  generateRuntimeConfig();
  log(
    `  RUM client token: ${persistResult.changed ? "updated" : "already current"} ` +
      "(0600, value never printed); runtime config regenerated with it.",
  );

  if (persistResult.changed) {
    log(
      "lab:up — RUM token changed; recreating openobserve and reverse-proxy so both reflect it...",
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
    runDockerCompose(["up", "-d", "--force-recreate", "openobserve", "reverse-proxy"]);
    const rumWaitResult = await waitForHealthy({ services: ["openobserve", "reverse-proxy"] });
    if (!rumWaitResult.healthy) {
      throw new Error(
        "openobserve/reverse-proxy did not become healthy again after the RUM token refresh.",
      );
    }
  }

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
