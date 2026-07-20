// `pnpm lab:streams:dry-run` — read current settings for both canonical
// streams, normalize, diff against the desired manifests, and print the
// result. Never writes. Exits 0 in all cases (this is an informational
// report, not a gate) — pnpm test:stage15:streams is what turns
// "unexpected diff" into a hard failure.

import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { classifySettingsDiff } from "./streams/drift.js";
import { getStreamSchema, readAdminAuthHeader } from "./streams/admin-client.mjs";
import { loadAllStreamDefinitions } from "./streams/load-manifests.mjs";
import { diffSettings, isNoChange, normalizeServerSettings } from "./streams/manifest.js";

export async function streamsDryRun() {
  const auth = readAdminAuthHeader();
  const results = [];
  for (const { manifest } of loadAllStreamDefinitions()) {
    const schema = await getStreamSchema(auth, manifest.streamName, manifest.streamType);
    if (!schema) {
      results.push({ stream: manifest.streamName, exists: false, diffs: [] });
      continue;
    }
    const normalized = normalizeServerSettings(schema.settings, manifest.volatileServerFields);
    const diffs = diffSettings(manifest.desiredSettings, normalized);
    results.push({
      stream: manifest.streamName,
      exists: true,
      diffs: diffs.map((diff) => ({ ...diff, driftClass: classifySettingsDiff(diff) })),
    });
  }
  return results;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:streams:dry-run");
    const results = await streamsDryRun();
    log("lab:streams:dry-run (read-only, no writes)");
    for (const result of results) {
      if (!result.exists) {
        log(`  ${result.stream}: does not exist yet (would be created on first ingest)`);
        continue;
      }
      if (isNoChange(result.diffs)) {
        log(`  ${result.stream}: NO_CHANGE`);
        continue;
      }
      log(`  ${result.stream}: ${result.diffs.length} diff(s)`);
      for (const diff of result.diffs) {
        log(
          `    - ${diff.field}: desired=${JSON.stringify(diff.desired)} actual=${JSON.stringify(diff.actual)} [${diff.driftClass}]`,
        );
      }
    }
    process.exit(0);
  } catch (error) {
    logError(`lab:streams:dry-run FAILED: ${error.message}`);
    process.exit(1);
  }
}
