import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

import {
  certsDir,
  composeArgs,
  dockerEnv,
  dockerDir,
  generatedDir,
  assertExactLabToolchain,
  log,
  secretsDir,
  SERVICES,
} from "./common.mjs";

export function getComposeStatus() {
  const result = spawnSync("docker", composeArgs(["ps", "--format", "json", "-a"]), {
    cwd: dockerDir,
    env: dockerEnv(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ps failed:\n${result.stdout}\n${result.stderr}`);
  }
  const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line));
}

export function summarizeStatus() {
  const containers = getComposeStatus();
  const byService = new Map(containers.map((c) => [c.Service, c]));

  const services = SERVICES.map((name) => {
    const container = byService.get(name);
    return {
      service: name,
      state: container?.State ?? "missing",
      health: container?.Health ?? "unknown",
      ports:
        container?.Publishers?.filter((p) => p.PublishedPort > 0).map(
          (p) => `${p.URL}:${p.PublishedPort}->${p.TargetPort}/${p.Protocol}`,
        ) ?? [],
      image: container?.Image ?? null,
    };
  });

  const runtimeFiles = [
    `${secretsDir}/openobserve-root-email`,
    `${secretsDir}/openobserve-root-password`,
    `${certsDir}/lab-ca.key`,
    `${certsDir}/localhost.key`,
    `${certsDir}/lab-ca.crt`,
    `${certsDir}/localhost.crt`,
    `${generatedDir}/runtime-config.json`,
  ].map((path) => ({
    path,
    exists: existsSync(path),
    mode: existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : null,
  }));

  return { services, runtimeFiles };
}

function printStatus() {
  const { services, runtimeFiles } = summarizeStatus();
  log("Services:");
  for (const s of services) {
    log(
      `  ${s.service.padEnd(15)} state=${s.state.padEnd(10)} health=${s.health.padEnd(10)} ports=${s.ports.join(", ") || "-"} image=${s.image ?? "-"}`,
    );
  }
  log("\nRuntime files (permissions only, never values):");
  for (const f of runtimeFiles) {
    log(`  ${f.path.padEnd(60)} exists=${f.exists} mode=${f.mode ?? "-"}`);
  }
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:status");
    printStatus();
  } catch (error) {
    process.stderr.write(`lab:status FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
