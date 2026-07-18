import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  caKeyPath,
  composeArgs,
  dockerDir,
  dockerEnv,
  emailSecretPath,
  fileMode,
  leafKeyPath,
  passwordSecretPath,
  repoRoot,
  runtimeConfigPath,
  runtimeDir,
} from "./common.mjs";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isGitIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "-q", path], { cwd: repoRoot });
  return result.status === 0;
}

function readSecrets() {
  return {
    email: readFileSync(emailSecretPath, "utf8"),
    password: readFileSync(passwordSecretPath, "utf8"),
  };
}

/**
 * Never prints the secret values themselves — only whether a sha256 canary
 * of each value shows up somewhere it must not.
 */
export function checkSecretSecurity() {
  const findings = [];

  if (!isGitIgnored(runtimeDir)) {
    findings.push(".runtime/ is not covered by .gitignore.");
  }

  for (const path of [emailSecretPath, passwordSecretPath]) {
    if (lstatSync(path).isSymbolicLink()) findings.push(`${path} is a symlink.`);
    if (fileMode(path) !== 0o600)
      findings.push(`${path} is not mode 0600 (got ${fileMode(path).toString(8)}).`);
  }
  for (const path of [caKeyPath, leafKeyPath]) {
    if (lstatSync(path).isSymbolicLink()) findings.push(`${path} is a symlink.`);
    if (fileMode(path) !== 0o600)
      findings.push(`${path} is not mode 0600 (got ${fileMode(path).toString(8)}).`);
  }

  const { email, password } = readSecrets();
  const secretHashes = new Set([sha256(email), sha256(password)]);

  const composeConfig = spawnSync("docker", composeArgs(["config"]), {
    cwd: dockerDir,
    env: dockerEnv(),
    encoding: "utf8",
  }).stdout;
  if (
    secretHashes.has(sha256(composeConfig)) ||
    composeConfig.includes(password) ||
    composeConfig.includes(email)
  ) {
    findings.push("A secret value literal appears in `docker compose config` output.");
  }

  const containerEnv = spawnSync(
    "docker",
    ["inspect", "chicek-lab-openobserve-1", "--format", "{{.Config.Env}}"],
    { encoding: "utf8" },
  ).stdout;
  if (containerEnv.includes(password) || containerEnv.includes(email)) {
    findings.push(
      "A secret value literal appears in the openobserve container's config environment.",
    );
  }

  const logs = spawnSync("docker", ["logs", "chicek-lab-openobserve-1"], { encoding: "utf8" });
  const logText = `${logs.stdout ?? ""}${logs.stderr ?? ""}`;
  if (logText.includes(password) || logText.includes(email)) {
    findings.push("A secret value literal appears in openobserve container logs.");
  }

  if (existsSync(runtimeConfigPath)) {
    const runtimeConfigText = readFileSync(runtimeConfigPath, "utf8");
    if (runtimeConfigText.includes(password) || runtimeConfigText.includes(email)) {
      findings.push("A secret value literal appears in the generated runtime config.");
    }
    const runtimeConfig = JSON.parse(runtimeConfigText);
    if (
      runtimeConfig.rum?.endpoint ||
      runtimeConfig.rum?.applicationId ||
      runtimeConfig.rum?.organizationId
    ) {
      findings.push("Runtime config unexpectedly contains RUM connection fields while disabled.");
    }
  } else {
    findings.push("Generated runtime config is missing.");
  }

  return { pass: findings.length === 0, findings };
}
