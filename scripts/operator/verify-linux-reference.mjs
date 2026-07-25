#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertExactLabToolchain, log, logError, repoRoot } from "../lab/common.mjs";

const SERVICES = Object.freeze([
  {
    file: "telemetry-ingest.service",
    user: "chicek-telemetry-ingest",
    env: "/etc/chicek-observability/telemetry-ingest.env",
    state: "/var/lib/chicek-observability/telemetry-ingest",
    exec: "apps/telemetry-ingest/src/server.js",
  },
  {
    file: "telemetry-delivery-worker.service",
    user: "chicek-telemetry-delivery",
    env: "/etc/chicek-observability/telemetry-delivery-worker.env",
    state: "/var/lib/chicek-observability/telemetry-delivery-worker",
    exec: "apps/telemetry-delivery-worker/src/worker.js",
  },
  {
    file: "observability-control-plane.service",
    user: "chicek-control-plane",
    env: "/etc/chicek-observability/observability-control-plane.env",
    state: "/var/lib/chicek-observability/control-plane",
    exec: "apps/observability-control-plane/src/server.js",
  },
  {
    file: "session-metadata-sync.service",
    user: "chicek-session-metadata",
    env: "/etc/chicek-observability/session-metadata-sync.env",
    state: "/var/lib/chicek-observability/session-metadata",
    exec: "apps/session-metadata-sync/src/server.js",
  },
]);

function verifyLinuxReference() {
  const findings = [];
  const base = join(repoRoot, "infrastructure/systemd");
  for (const service of SERVICES) {
    const path = join(base, service.file);
    if (!existsSync(path)) {
      findings.push(`${service.file}: missing`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    const required = [
      `User=${service.user}`,
      `Group=${service.user}`,
      "WorkingDirectory=/opt/chicek-observability/current",
      `EnvironmentFile=${service.env}`,
      `ExecStart=/usr/bin/node ${service.exec}`,
      "Restart=on-failure",
      "StandardOutput=journal",
      "StandardError=journal",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=true",
      "PrivateTmp=true",
      "PrivateDevices=true",
      `ReadWritePaths=${service.state}`,
      "ReadOnlyPaths=/etc/chicek-observability",
      "CapabilityBoundingSet=",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
    ];
    for (const needle of required) {
      if (!text.includes(needle)) findings.push(`${service.file}: missing ${needle}`);
    }
  }
  return {
    pass: findings.length === 0,
    findings,
    services: SERVICES.map(({ file, user, env, state, exec }) => ({
      file,
      user,
      env,
      state,
      exec,
    })),
    directories: {
      install: "/opt/chicek-observability/current",
      config: "/etc/chicek-observability",
      stateRoot: "/var/lib/chicek-observability",
    },
    logging: "journald",
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("test:linux-reference");
    const result = verifyLinuxReference();
    log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:linux-reference FAILED: ${error.message}`);
    process.exit(1);
  }
}
