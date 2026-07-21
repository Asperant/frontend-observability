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

// distinct_value_fields is additive-only and a single PUT only ever
// registers the first name in the array (see
// docs/openobserve-v0.91-stream-capabilities.md capability #11a) — it
// cannot share the generic single-PUT patch every other managed field
// uses. Each name in the desired list that isn't already present needs its
// own sequential call, shaped as a one-element nested array.
async function applyDistinctValueFieldsDiff(auth, manifest, diff, actualNames) {
  const missingNames = diff.desired.filter((name) => !actualNames.includes(name));
  for (const name of missingNames) {
    const result = await updateStreamSettings(
      auth,
      manifest.streamName,
      { distinct_value_fields: [[name]] },
      manifest.streamType,
    );
    if (!result.ok) return result;
  }
  return { ok: true };
}

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

    const distinctDiff = diffs.find((diff) => diff.field === "distinct_value_fields");
    const otherDiffs = diffs.filter((diff) => diff.field !== "distinct_value_fields");

    let applyResult = { ok: true };
    if (otherDiffs.length > 0) {
      const patch = Object.fromEntries(otherDiffs.map((diff) => [diff.field, diff.desired]));
      applyResult = await updateStreamSettings(
        auth,
        manifest.streamName,
        patch,
        manifest.streamType,
      );
    }
    if (applyResult.ok && distinctDiff) {
      applyResult = await applyDistinctValueFieldsDiff(
        auth,
        manifest,
        distinctDiff,
        before.distinct_value_fields ?? [],
      );
    }
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
