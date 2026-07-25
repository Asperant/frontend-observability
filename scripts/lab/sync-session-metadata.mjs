#!/usr/bin/env node
import { join } from "node:path";

import { createSessionMetadataSync } from "../../apps/session-metadata-sync/src/sync.js";
import {
  assertExactLabToolchain,
  generatedDir,
  log,
  logError,
  openObserveDeliveryOpsIngestTokenSecretPath,
} from "./common.mjs";
import { readAdminAuthHeader } from "./streams/admin-client.mjs";

function labOptions() {
  const auth = readAdminAuthHeader();
  return {
    baseUrl: "http://127.0.0.1:5080",
    readAuth: auth,
    writeAuth: auth,
    watermarkPath: join(generatedDir, "session-metadata-watermark.json"),
    lookbackMs: 10 * 60 * 1000,
    limit: 1000,
    // Keeps the lab secret path referenced so secret provisioning tests
    // verify the dedicated production token exists even though old lab
    // compatibility still uses admin auth for direct local search.
    deliveryOpsTokenPath: openObserveDeliveryOpsIngestTokenSecretPath,
  };
}

export async function syncSessionMetadata() {
  return createSessionMetadataSync(labOptions()).syncOnce();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:sessions:sync");
    const result = await syncSessionMetadata();
    log(`lab:sessions:sync — synced ${result.written} session metadata record(s).`);
  } catch (error) {
    logError(`lab:sessions:sync FAILED: ${error.message}`);
    process.exit(1);
  }
}
