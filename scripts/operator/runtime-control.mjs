#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createControlPlaneState } from "../../apps/observability-control-plane/src/state.js";
import { atomicWriteText } from "../../apps/observability-control-plane/src/io.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const stateDir =
  process.env.OBSERVABILITY_CONTROL_STATE_DIR ?? join(repoRoot, ".runtime/control-plane");
const controlPlane = createControlPlaneState(stateDir);
const { command, reasonCode, scope } = parseArgs(process.argv.slice(2));

if (command === "enable") {
  const result = controlPlane.publishControl({ active: false, scope });
  syncDeliveryControl(result);
  print(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === "disable") {
  const result = controlPlane.publishControl({
    active: true,
    reasonCode: reasonCode ?? "operator_request",
    scope,
  });
  syncDeliveryControl(result);
  print(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === "status") {
  print(controlPlane.status(new Date(), scope).control);
  process.exit(0);
}

fail(
  "usage: runtime-control <enable|disable|status> [reasonCode] [--service name --environment env]",
);

function parseArgs(args) {
  const positional = [];
  const scope = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--service") {
      scope.service = args[++index];
      continue;
    }
    if (value === "--environment") {
      scope.environment = args[++index];
      continue;
    }
    positional.push(value);
  }
  return {
    command: positional[0],
    reasonCode: positional[1],
    scope:
      scope.service !== undefined || scope.environment !== undefined
        ? { service: scope.service, environment: scope.environment }
        : undefined,
  };
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function syncDeliveryControl(result) {
  const path = process.env.OBSERVABILITY_DELIVERY_CONTROL_FILE;
  if (!result.ok || !path) return;
  const document = controlPlane.deliveryControlDocument();
  atomicWriteText(path, `${JSON.stringify(document, null, 2)}\n`, 0o644);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
