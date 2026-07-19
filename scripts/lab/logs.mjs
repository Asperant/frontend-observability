import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  composeArgs,
  dockerDir,
  dockerEnv,
  emailSecretPath,
  passwordSecretPath,
  assertExactLabToolchain,
  log,
  redactSecrets,
} from "./common.mjs";

function secretValues() {
  const values = [];
  for (const path of [emailSecretPath, passwordSecretPath]) {
    if (existsSync(path)) values.push(readFileSync(path, "utf8"));
  }
  return values;
}

export function labLogs(extraArgs = []) {
  const result = spawnSync("docker", composeArgs(["logs", "--tail", "200", ...extraArgs]), {
    cwd: dockerDir,
    env: dockerEnv(),
    encoding: "utf8",
  });
  return redactSecrets(`${result.stdout ?? ""}${result.stderr ?? ""}`, secretValues());
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:logs");
    log(labLogs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`lab:logs FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
