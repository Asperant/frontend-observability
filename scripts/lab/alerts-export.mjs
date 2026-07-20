import { join } from "node:path";

import {
  assertExactLabToolchain,
  atomicWriteFile,
  generatedDir,
  log,
  logError,
} from "./common.mjs";
import { exportAlert, listAlerts, readAdminAuthHeader } from "./alerts/admin-client.mjs";
import { normalizeAlertExport } from "./alerts/policy.js";

export async function alertsExport() {
  const auth = readAdminAuthHeader();
  const exported = [];
  for (const item of await listAlerts(auth)) {
    const result = await exportAlert(auth, item.alert_id ?? item.id);
    if (result.status === 200) exported.push(normalizeAlertExport(result.body));
  }
  const path = join(generatedDir, "alerts-export.candidate.json");
  atomicWriteFile(
    path,
    `${JSON.stringify({ exportedAt: new Date().toISOString(), alerts: exported }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { path, count: exported.length };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:export");
    const result = await alertsExport();
    log(`lab:alerts:export wrote candidate (${result.count} alerts)`);
  } catch (error) {
    logError(`lab:alerts:export FAILED: ${error.message}`);
    process.exit(1);
  }
}
