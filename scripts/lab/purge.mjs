import { createInterface } from "node:readline/promises";
import { rmSync } from "node:fs";

import {
  assertExactLabToolchain,
  log,
  logError,
  runDockerCompose,
  runtimeControlDaemonPidPath,
  runtimeDir,
  sessionMetadataDaemonPidPath,
  stopDetachedProcess,
} from "./common.mjs";

async function confirmInteractively() {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "This will permanently delete the openobserve-data volume and .runtime/ (secrets, certs, runtime config). Type 'yes' to continue: ",
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Destructive by design, so it refuses by default. Requires either an
 * explicit interactive "yes" or `--yes`/`-y` on the command line. CI (no
 * TTY) can only proceed via `--yes`. Only ever touches this compose
 * project's own containers/networks/volumes and this repo's `.runtime/`.
 */
export async function labPurge({ yes = false } = {}) {
  const confirmed = yes || (await confirmInteractively());
  if (!confirmed) {
    logError("lab:purge aborted: confirmation required (pass --yes or confirm interactively).");
    return { purged: false };
  }

  log("lab:purge — stopping the runtime-control refresh daemon...");
  stopDetachedProcess(runtimeControlDaemonPidPath);

  log("lab:purge — stopping the session metadata sync daemon...");
  stopDetachedProcess(sessionMetadataDaemonPidPath);

  log("lab:purge — removing containers, networks, and volumes for this project...");
  runDockerCompose(["down", "--volumes", "--remove-orphans"]);

  log("lab:purge — removing .runtime/ ...");
  rmSync(runtimeDir, { recursive: true, force: true });

  log("lab:purge complete.");
  return { purged: true };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  const yes = process.argv.includes("--yes") || process.argv.includes("-y");
  if (!yes && process.env.CI) {
    logError("lab:purge FAILED: CI runs require --yes.");
    process.exit(1);
  }
  try {
    assertExactLabToolchain("lab:purge");
    const result = await labPurge({ yes });
    if (!result.purged) process.exit(1);
  } catch (error) {
    logError(`lab:purge FAILED: ${error.message}`);
    process.exit(1);
  }
}
