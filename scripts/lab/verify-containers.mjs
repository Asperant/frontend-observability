import { spawnSync } from "node:child_process";

import { COMPOSE_PROJECT_NAME, SERVICES } from "./common.mjs";

function containerName(service) {
  return `${COMPOSE_PROJECT_NAME}-${service}-1`;
}

function dockerInspect(name, format) {
  const result = spawnSync("docker", ["inspect", name, "--format", format], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker inspect ${name} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runInImage(image, args) {
  return spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", args], {
    encoding: "utf8",
  });
}

const NON_ROOT_USERS = {
  "reverse-proxy": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  "browser-app": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  "http-test-service": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  "telemetry-ingest": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  rabbitmq: (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  "telemetry-delivery-worker": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  "observability-control-plane": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  "session-metadata-sync": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  "alert-sink": (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
  openobserve: (user) => user !== "" && user !== "0" && !user.startsWith("0:"),
};

export function checkContainerSecurity() {
  const findings = [];

  for (const service of SERVICES) {
    const name = containerName(service);
    const user = dockerInspect(name, "{{.Config.User}}");
    const nonRootUser = NON_ROOT_USERS[service];
    if (typeof nonRootUser !== "function") {
      findings.push(`${service}: missing non-root user validator.`);
    } else if (!nonRootUser(user)) {
      findings.push(`${service}: expected a non-root user, got "${user}".`);
    }

    const readOnly = dockerInspect(name, "{{.HostConfig.ReadonlyRootfs}}");
    if (readOnly !== "true") {
      findings.push(`${service}: root filesystem is not read-only.`);
    }

    const securityOpt = dockerInspect(name, "{{.HostConfig.SecurityOpt}}");
    if (!securityOpt.includes("no-new-privileges:true")) {
      findings.push(`${service}: no-new-privileges:true is not set.`);
    }

    const capDrop = dockerInspect(name, "{{.HostConfig.CapDrop}}");
    if (!capDrop.includes("ALL")) {
      findings.push(`${service}: capabilities are not dropped (cap_drop: ALL).`);
    }
  }

  const nodeCheck = runInImage(
    "chicek-lab/browser-app-fixture:6.0.0",
    "command -v node || echo MISSING",
  );
  if (!nodeCheck.stdout.includes("MISSING")) {
    findings.push("browser-app image contains a node executable.");
  }
  const pnpmCheck = runInImage(
    "chicek-lab/browser-app-fixture:6.0.0",
    "command -v pnpm || echo MISSING",
  );
  if (!pnpmCheck.stdout.includes("MISSING")) {
    findings.push("browser-app image contains a pnpm executable.");
  }

  const mapCheck = runInImage(
    "chicek-lab/browser-app-fixture:6.0.0",
    "grep -rl sourceMappingURL /usr/share/nginx/html || echo NO_MAPS",
  );
  if (!mapCheck.stdout.includes("NO_MAPS")) {
    findings.push("browser-app image dist output contains a source map reference.");
  }

  return { pass: findings.length === 0, findings };
}
