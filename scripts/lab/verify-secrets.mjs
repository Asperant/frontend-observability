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
  rumClientTokenSecretPath,
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
    rumClientToken: readFileSync(rumClientTokenSecretPath, "utf8").trim(),
  };
}

/**
 * Never prints the secret values themselves — only whether a sha256 canary
 * of each value shows up somewhere it must not. The RUM client token is
 * intentionally treated differently from the root email/password: it is
 * *expected* to appear in the generated runtime config (browsers must read
 * it to call the SDK) and in the openobserve container's env (ZO_RUM_CLIENT_TOKEN,
 * so the server can authorize ingestion) — it is a browser-exposed ingestion
 * credential, not an admin/root one. What must still hold is that it is its
 * own distinct secret (never equal to the root email/password), stored with
 * the same file hygiene, and never printed to logs.
 */
export function checkSecretSecurity() {
  const findings = [];

  if (!isGitIgnored(runtimeDir)) {
    findings.push(".runtime/ is not covered by .gitignore.");
  }

  for (const path of [emailSecretPath, passwordSecretPath, rumClientTokenSecretPath]) {
    if (lstatSync(path).isSymbolicLink()) findings.push(`${path} is a symlink.`);
    if (fileMode(path) !== 0o600)
      findings.push(`${path} is not mode 0600 (got ${fileMode(path).toString(8)}).`);
  }
  for (const path of [caKeyPath, leafKeyPath]) {
    if (lstatSync(path).isSymbolicLink()) findings.push(`${path} is a symlink.`);
    if (fileMode(path) !== 0o600)
      findings.push(`${path} is not mode 0600 (got ${fileMode(path).toString(8)}).`);
  }

  const { email, password, rumClientToken } = readSecrets();
  const secretHashes = new Set([sha256(email), sha256(password)]);

  if (rumClientToken === email || rumClientToken === password) {
    findings.push("The RUM client token must be distinct from the root email/password secret.");
  }

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
    findings.push("A root secret value literal appears in `docker compose config` output.");
  }

  const containerEnv = spawnSync(
    "docker",
    ["inspect", "chicek-lab-openobserve-1", "--format", "{{.Config.Env}}"],
    { encoding: "utf8" },
  ).stdout;
  if (containerEnv.includes(password) || containerEnv.includes(email)) {
    findings.push(
      "A root secret value literal appears in the openobserve container's config environment.",
    );
  }

  // The RUM client token is checked by the dedicated proxy-security gate:
  // browser-facing ingestion is queryless, and reverse-proxy metadata logs
  // must not contain token values.
  const logs = spawnSync("docker", ["logs", "chicek-lab-openobserve-1"], { encoding: "utf8" });
  const logText = `${logs.stdout ?? ""}${logs.stderr ?? ""}`;
  if (logText.includes(password) || logText.includes(email)) {
    findings.push("A root secret value literal appears in openobserve container logs.");
  }

  if (existsSync(runtimeConfigPath)) {
    const runtimeConfigText = readFileSync(runtimeConfigPath, "utf8");
    if (runtimeConfigText.includes(password) || runtimeConfigText.includes(email)) {
      findings.push("The root email/password secret appears in the generated runtime config.");
    }
    const runtimeConfig = JSON.parse(runtimeConfigText);
    if (runtimeConfig.enabled && runtimeConfig.rum?.clientToken !== rumClientToken) {
      findings.push(
        "Runtime config's rum.clientToken does not match the generated RUM secret file.",
      );
    }
  } else {
    findings.push("Generated runtime config is missing.");
  }

  return { pass: findings.length === 0, findings };
}
