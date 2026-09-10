#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertExactLabToolchain, log, logError, repoRoot } from "../lab/common.mjs";

const SERVICES = Object.freeze([
  {
    file: "telemetry-ingest.service",
    user: "frontend-observability-telemetry-ingest",
    env: "/etc/frontend-observability/telemetry-ingest.env",
    state: "/var/lib/frontend-observability/telemetry-ingest",
    exec: "apps/telemetry-ingest/src/server.js",
  },
  {
    file: "telemetry-delivery-worker.service",
    user: "frontend-observability-telemetry-delivery",
    env: "/etc/frontend-observability/telemetry-delivery-worker.env",
    state: "/var/lib/frontend-observability/telemetry-delivery-worker",
    exec: "apps/telemetry-delivery-worker/src/worker.js",
  },
  {
    file: "observability-control-plane.service",
    user: "frontend-observability-control-plane",
    env: "/etc/frontend-observability/observability-control-plane.env",
    state: "/var/lib/frontend-observability/control-plane",
    exec: "apps/observability-control-plane/src/server.js",
  },
  {
    file: "session-metadata-sync.service",
    user: "frontend-observability-session-metadata",
    env: "/etc/frontend-observability/session-metadata-sync.env",
    state: "/var/lib/frontend-observability/session-metadata",
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
      "WorkingDirectory=/opt/frontend-observability/current",
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
      "ReadOnlyPaths=/etc/frontend-observability",
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
      install: "/opt/frontend-observability/current",
      config: "/etc/frontend-observability",
      stateRoot: "/var/lib/frontend-observability",
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
