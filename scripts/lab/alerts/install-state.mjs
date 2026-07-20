import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile, runtimeDir } from "../common.mjs";

const installStatePath = join(runtimeDir, "alerts-install-state.json");

export function readInstallState() {
  if (!existsSync(installStatePath)) return { installedStarters: {} };
  return JSON.parse(readFileSync(installStatePath, "utf8"));
}

export function recordStarterInstalled(starterId, version) {
  const state = readInstallState();
  state.installedStarters[starterId] = { version };
  atomicWriteFile(installStatePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
