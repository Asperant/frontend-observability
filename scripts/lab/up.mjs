import { assertExactLabToolchain, run, log, runDockerCompose } from "./common.mjs";
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
