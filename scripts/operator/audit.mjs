#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createControlPlaneState } from "../../apps/observability-control-plane/src/state.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const stateDir =
  process.env.OBSERVABILITY_CONTROL_STATE_DIR ?? join(repoRoot, ".runtime/control-plane");
const controlPlane = createControlPlaneState(stateDir);
const limit = Number.parseInt(process.argv[2] ?? "50", 10);

for (const line of controlPlane.auditLines(Number.isSafeInteger(limit) ? limit : 50)) {
  console.log(line);
}
