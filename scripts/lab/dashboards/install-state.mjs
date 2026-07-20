// Local, lab-only record of which starter dashboards this repo's tooling
// has successfully created at least once. Lives under .runtime/generated/
// (gitignored, matches .runtime/generated/runtime-control.json's own
// read-before-write convention — scripts/lab/generate-runtime-control.mjs).
// This is the only mechanism that lets install-starters tell "never
// installed yet" apart from "installed once, then deleted by the company":
// OpenObserve keeps no tombstone for a deleted dashboard (capability #9), so
// without this record a normal install run could not distinguish the two
// and would end up silently resurrecting a company deletion. Pure I/O — not
// unit-coverage-gated, mirroring scripts/lab/dashboards/admin-client.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile, generatedDir } from "../common.mjs";

const STATE_PATH = join(generatedDir, "dashboard-install-state.json");

export function readInstallState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { schemaVersion: 1, installedStarters: {} };
  }
}

export function recordStarterInstalled(starterId, version) {
  const state = readInstallState();
  state.installedStarters[starterId] = { version, installedAt: new Date().toISOString() };
  atomicWriteFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
