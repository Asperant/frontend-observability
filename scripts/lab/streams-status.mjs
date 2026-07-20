// `pnpm lab:streams:status` — read-only summary of the two canonical
// OpenObserve streams (_rumdata/_rumlog): existence, doc count, and the
// managed settings subset, with no diffing/writing. Safe to run at any
// time; never prints a secret or raw telemetry value.

import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { getStreamSchema, readAdminAuthHeader } from "./streams/admin-client.mjs";
import { loadAllStreamDefinitions } from "./streams/load-manifests.mjs";
import { normalizeServerSettings } from "./streams/manifest.js";

export async function streamsStatus() {
  const auth = readAdminAuthHeader();
  const rows = [];
  for (const { manifest } of loadAllStreamDefinitions()) {
    const schema = await getStreamSchema(auth, manifest.streamName, manifest.streamType);
    if (!schema) {
      rows.push({ stream: manifest.streamName, exists: false });
      continue;
    }
    const settings = normalizeServerSettings(schema.settings, manifest.volatileServerFields);
    rows.push({
      stream: manifest.streamName,
      exists: true,
      docNum: schema.stats?.doc_num ?? 0,
      totalFields: schema.total_fields ?? 0,
      settings: {
        data_retention: settings.data_retention,
        max_query_range: settings.max_query_range,
        store_original_data: settings.store_original_data,
        full_text_search_keys: settings.full_text_search_keys,
        index_fields: settings.index_fields,
        bloom_filter_fields: settings.bloom_filter_fields,
        partition_keys: settings.partition_keys,
      },
    });
  }
  return rows;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:streams:status");
    const rows = await streamsStatus();
    log("lab:streams:status");
    for (const row of rows) {
      if (!row.exists) {
        log(`  ${row.stream}: does not exist yet`);
        continue;
      }
      log(
        `  ${row.stream}: doc_num=${row.docNum} total_fields=${row.totalFields} ` +
          `retention=${row.settings.data_retention}d max_query_range=${row.settings.max_query_range}h ` +
          `store_original_data=${row.settings.store_original_data} ` +
          `index=[fts=${row.settings.full_text_search_keys.length},idx=${row.settings.index_fields.length},` +
          `bloom=${row.settings.bloom_filter_fields.length}] ` +
          `partition_keys=${Array.isArray(row.settings.partition_keys) ? row.settings.partition_keys.length : "custom"}`,
      );
    }
    process.exit(0);
  } catch (error) {
    logError(`lab:streams:status FAILED: ${error.message}`);
    process.exit(1);
  }
}
