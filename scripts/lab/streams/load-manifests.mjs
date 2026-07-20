import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../common.mjs";

const STREAMS_DIR = join(repoRoot, "infrastructure/openobserve/streams");

export const CANONICAL_STREAM_KEYS = Object.freeze(["rumdata", "rumlog"]);

function readJson(fileName) {
  return JSON.parse(readFileSync(join(STREAMS_DIR, fileName), "utf8"));
}

/**
 * Loads the manifest + schema-contract pair for one canonical stream key
 * ("rumdata" | "rumlog"), matching infrastructure/openobserve/streams/'s
 * fixed file naming.
 */
export function loadStreamDefinition(key) {
  const manifest = readJson(`${key}.stream.json`);
  const contract = readJson(`${key}.schema-contract.json`);
  return { key, manifest, contract };
}

export function loadAllStreamDefinitions() {
  return CANONICAL_STREAM_KEYS.map(loadStreamDefinition);
}
