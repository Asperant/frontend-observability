// `pnpm lab:streams:provision` — applies each canonical stream's desired
// settings (infrastructure/openobserve/streams/*.stream.json), but only
// ever the exact, pre-validated non-destructive field/value pairs
// (scripts/lab/streams/guard.js's isNonDestructiveSettingsChange): no type
// change, no field removal, no enabling UDS/store-original, no canonical
// stream/data delete, no breaking index migration, no unsupported field —
// see docs/openobserve-stream-schema-lifecycle.md. Order per stream: read
// current -> diff -> refuse anything not provably non-destructive -> apply
// -> read-back -> re-diff (must be NO_CHANGE).

import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { isNonDestructiveSettingsChange } from "./streams/guard.js";
import {
  getStreamSchema,
  readAdminAuthHeader,
  updateStreamSettings,
} from "./streams/admin-client.mjs";
import { loadAllStreamDefinitions } from "./streams/load-manifests.mjs";
import { diffSettings, isNoChange, normalizeServerSettings } from "./streams/manifest.js";

export async function streamsProvision() {
  const auth = readAdminAuthHeader();
  const results = [];
  for (const { manifest } of loadAllStreamDefinitions()) {
    const schema = await getStreamSchema(auth, manifest.streamName, manifest.streamType);
    if (!schema) {
      results.push({
        stream: manifest.streamName,
        outcome: "SKIPPED_STREAM_DOES_NOT_EXIST",
      });
      continue;
    }

    const before = normalizeServerSettings(schema.settings, manifest.volatileServerFields);
    const diffs = diffSettings(manifest.desiredSettings, before);
    if (isNoChange(diffs)) {
      results.push({ stream: manifest.streamName, outcome: "NO_CHANGE" });
      continue;
    }

    const refused = diffs.filter(
      (diff) => !isNonDestructiveSettingsChange(diff.field, diff.desired),
    );
    if (refused.length > 0) {
      results.push({
        stream: manifest.streamName,
        outcome: "REFUSED_NOT_PROVABLY_NON_DESTRUCTIVE",
        refused,
      });
      continue;
    }

    const patch = Object.fromEntries(diffs.map((diff) => [diff.field, diff.desired]));
    const applyResult = await updateStreamSettings(
      auth,
      manifest.streamName,
      patch,
      manifest.streamType,
    );
    if (!applyResult.ok) {
      results.push({
        stream: manifest.streamName,
        outcome: "APPLY_FAILED",
        status: applyResult.status,
      });
      continue;
    }

    const afterSchema = await getStreamSchema(auth, manifest.streamName, manifest.streamType);
    const after = normalizeServerSettings(afterSchema.settings, manifest.volatileServerFields);
    const remaining = diffSettings(manifest.desiredSettings, after);
    results.push({
      stream: manifest.streamName,
      outcome: isNoChange(remaining) ? "APPLIED" : "APPLIED_BUT_READBACK_MISMATCH",
      changedFields: diffs.map((diff) => diff.field),
      remaining,
    });
  }
  return results;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:streams:provision");
    const results = await streamsProvision();
    log("lab:streams:provision");
    let failed = false;
    for (const result of results) {
      log(`  ${result.stream}: ${result.outcome}`);
      if (result.outcome === "APPLIED") log(`    changed: ${result.changedFields.join(", ")}`);
      if (result.outcome === "REFUSED_NOT_PROVABLY_NON_DESTRUCTIVE") {
        failed = true;
        for (const diff of result.refused) {
          logError(`    refused: ${diff.field} -> ${JSON.stringify(diff.desired)}`);
        }
      }
      if (result.outcome === "APPLY_FAILED" || result.outcome === "APPLIED_BUT_READBACK_MISMATCH") {
        failed = true;
      }
    }
    process.exit(failed ? 1 : 0);
  } catch (error) {
    logError(`lab:streams:provision FAILED: ${error.message}`);
    process.exit(1);
  }
}
