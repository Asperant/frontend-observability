// I/O helper that assembles the environment fingerprint required on every
// Stage 19 benchmark/soak report (infrastructure/performance/stage19-environment-schema.json).
// Pure I/O, not coverage-gated — mirrors scripts/lab/streams/admin-client.mjs's
// own split between pure logic (gated) and thin I/O wrappers (not gated).
// Never reads or emits username/hostname/IP/credential/secret/token/private-path.

import { cpus, platform, release, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { composeFile, dockerDir, repoRoot, run } from "../../lab/common.mjs";

function readGitCommit() {
  const result = run("git", ["rev-parse", "HEAD"], { capture: true, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function readDockerVersion() {
  const result = run("docker", ["version", "--format", "{{.Server.Version}}"], {
    capture: true,
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function readDockerComposeVersion() {
  const result = run("docker", ["compose", "version", "--short"], {
    capture: true,
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function readOpenObserveImageInfo() {
  const lock = JSON.parse(readFileSync(join(dockerDir, "images.lock.json"), "utf8"));
  const openobserve = lock.images.find((image) => image.purpose === "openobserve");
  return {
    openobserveVersion: openobserve?.tag ?? "unknown",
    openobserveImageDigest: openobserve?.digest ?? "unknown",
  };
}

/**
 * Best-effort filesystem type backing the repo working directory (e.g.
 * "ext4", "overlay", "tmpfs"), read from `df -T`. Falls back to "unknown"
 * rather than failing the whole fingerprint — this field is informational.
 */
function readFilesystemType() {
  const result = spawnSync("df", ["-T", repoRoot], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return "unknown";
  const lines = result.stdout.trim().split("\n");
  if (lines.length < 2) return "unknown";
  const columns = lines[1].split(/\s+/);
  return columns[1] ?? "unknown";
}

function readContainerResourceLimits() {
  const compose = parseYaml(readFileSync(composeFile, "utf8"));
  const perService = {};
  for (const [name, service] of Object.entries(compose.services ?? {})) {
    const limits = service.deploy?.resources?.limits;
    perService[name] = {
      cpus: limits?.cpus ?? null,
      memory: limits?.memory ?? null,
      pids: limits?.pids ?? null,
    };
  }
  return perService;
}

/**
 * Assembles the full environment fingerprint object required on every
 * benchmark/soak report. `workloadProfile` is the profile name/variant the
 * caller is about to run (e.g. "normal", "sustained/standard-15m").
 */
export function collectEnvironmentFingerprint({ workloadProfile }) {
  return {
    gitCommit: readGitCommit(),
    nodeVersion: process.version,
    pnpmVersion:
      run("pnpm", ["--version"], { capture: true, allowFailure: true }).stdout?.trim() ?? "unknown",
    ...readOpenObserveImageInfo(),
    dockerVersion: readDockerVersion(),
    dockerComposeVersion: readDockerComposeVersion(),
    osPlatform: platform(),
    osRelease: release(),
    cpuCoreCount: cpus().length,
    totalMemoryBytes: totalmem(),
    containerResourceLimits: readContainerResourceLimits(),
    filesystemType: readFilesystemType(),
    startedAt: new Date().toISOString(),
    workloadProfile,
  };
}
