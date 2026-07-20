import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkExactNodeVersion, checkExactPnpmVersion } from "../verify/toolchain.js";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const dockerDir = join(repoRoot, "infrastructure/docker");
export const composeFile = join(dockerDir, "compose.yaml");
export const imagesLockFile = join(dockerDir, "images.lock.json");
export const runtimeDir = join(repoRoot, ".runtime");
export const secretsDir = join(runtimeDir, "secrets");
export const certsDir = join(runtimeDir, "certs");
export const generatedDir = join(runtimeDir, "generated");

export const emailSecretPath = join(secretsDir, "openobserve-root-email");
export const passwordSecretPath = join(secretsDir, "openobserve-root-password");
export const rumClientTokenSecretPath = join(secretsDir, "openobserve-rum-client-token");
export const caCertPath = join(certsDir, "lab-ca.crt");
export const caKeyPath = join(certsDir, "lab-ca.key");
export const leafCertPath = join(certsDir, "localhost.crt");
export const leafKeyPath = join(certsDir, "localhost.key");
export const runtimeConfigPath = join(generatedDir, "runtime-config.json");
// A single-file bind mount pins an already-running container to the inode
// it saw at mount time: an atomic-rename rewrite of the host file (as
// atomicWriteFile always does) is then invisible to that container even
// after `nginx -s reload`, until the container itself is recreated (see
// up.mjs's runtime-config.json handling, which works around exactly this by
// force-recreating on token change). The kill switch cannot pay that cost —
// it must take effect on an `nginx -s reload` alone — so these two files
// live in their own subdirectory, bind-mounted as a *directory* instead
// (infrastructure/docker/compose.yaml), which stays live across renames of
// the files inside it.
export const proxyDynamicDir = join(generatedDir, "proxy-dynamic");
export const runtimeControlPath = join(proxyDynamicDir, "runtime-control.json");
export const proxyGatePath = join(proxyDynamicDir, "proxy-gate.conf");

export const COMPOSE_PROJECT_NAME = "chicek-lab";

export const SERVICES = ["reverse-proxy", "demo-frontend", "mock-api", "openobserve", "alert-sink"];

/**
 * Every docker compose invocation must go through here so LAB_UID/LAB_GID
 * (used to make the bind-mounted OpenObserve secret files readable by the
 * container's non-root user without loosening their host-side 0600 mode)
 * and the pinned project name are always present, and so callers never have
 * to remember `-f`/`--project-name` themselves.
 */
export function composeArgs(args) {
  return ["compose", "-f", composeFile, "--project-name", COMPOSE_PROJECT_NAME, ...args];
}

export function runDockerCompose(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync("docker", composeArgs(args), {
    cwd: dockerDir,
    env: dockerEnv(),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    const detail = capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`docker compose ${args.join(" ")} failed (exit ${result.status}).${detail}`);
  }
  return result;
}

export function dockerEnv() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 10001;
  const gid = typeof process.getgid === "function" ? process.getgid() : 10001;
  return {
    ...process.env,
    LAB_UID: String(uid),
    LAB_GID: String(gid),
    COMPOSE_PROJECT_NAME,
  };
}

export function run(command, args, { capture = false, allowFailure = true, cwd = repoRoot } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    const detail = capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}).${detail}`);
  }
  return result;
}

export function checkExactLabToolchain(commandName, dependencies) {
  const nodeResult = checkExactNodeVersion(
    dependencies.expectedNodeVersion,
    dependencies.actualNodeVersion,
  );
  if (!nodeResult.ok) {
    return {
      ok: false,
      message: `${commandName} refused to run: ${nodeResult.message}`,
    };
  }

  const pnpmResult = checkExactPnpmVersion(
    dependencies.packageManager,
    dependencies.actualPnpmVersion,
  );
  if (!pnpmResult.ok) {
    return {
      ok: false,
      message: `${commandName} refused to run: ${pnpmResult.message}`,
    };
  }

  return {
    ok: true,
    node: nodeResult.actual,
    pnpm: pnpmResult.actual,
  };
}

export function readCurrentLabToolchain() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const pnpm = run("pnpm", ["--version"], { capture: true, allowFailure: true });
  if (pnpm.status !== 0) {
    return {
      expectedNodeVersion: readFileSync(join(repoRoot, ".node-version"), "utf8").trim(),
      packageManager: pkg.packageManager,
      actualNodeVersion: process.version,
      actualPnpmVersion: "",
      pnpmError: pnpm.stderr || pnpm.stdout || "Unable to run pnpm --version.",
    };
  }
  return {
    expectedNodeVersion: readFileSync(join(repoRoot, ".node-version"), "utf8").trim(),
    packageManager: pkg.packageManager,
    actualNodeVersion: process.version,
    actualPnpmVersion: pnpm.stdout.trim(),
  };
}

export function assertExactLabToolchain(commandName) {
  const dependencies = readCurrentLabToolchain();
  if (dependencies.pnpmError) {
    throw new Error(`${commandName} refused to run: ${dependencies.pnpmError}`);
  }
  const result = checkExactLabToolchain(commandName, dependencies);
  if (!result.ok) throw new Error(result.message);
  return result;
}

/**
 * Writes `data` to `path` by first writing to a sibling temp file and then
 * renaming it into place, so a reader never observes a partially written
 * file. Refuses to write through an existing symlink.
 */
export function atomicWriteFile(path, data, { mode } = {}) {
  rejectSymlink(path);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempDir = mkdtempSync(join(dir, ".tmp-"));
  const tempFile = join(tempDir, "write");
  try {
    writeFileSync(tempFile, data, { mode: mode ?? 0o600 });
    renameSync(tempFile, path);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

export function rejectSymlink(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${path}`);
  }
}

export function fileMode(path) {
  return statSync(path).mode & 0o777;
}

export function isWorldOrGroupReadableSecret(path) {
  const mode = fileMode(path);
  return Boolean(mode & (fsConstants.S_IRWXG | fsConstants.S_IRWXO));
}

const SECRET_REDACTION = "[redacted]";

/**
 * Replaces any occurrence of the given literal secret values in `text` with
 * a fixed placeholder. Used by lab:logs and lab:status so real credential
 * material can never reach stdout/stderr, even indirectly.
 */
export function redactSecrets(text, secretValues) {
  let redacted = text;
  for (const value of secretValues) {
    if (!value) continue;
    redacted = redacted.split(value).join(SECRET_REDACTION);
  }
  return redacted;
}

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export function logError(message) {
  process.stderr.write(`${message}\n`);
}
