import { join } from "node:path";

import {
  assertExactLabToolchain,
  atomicWriteFile,
  generatedDir,
  log,
  logError,
} from "./common.mjs";
import { getAlert, listAlerts, readAdminAuthHeader } from "./alerts/admin-client.mjs";
import { normalizeAlertExport } from "./alerts/policy.js";

export async function alertsBackup() {
  const auth = readAdminAuthHeader();
  const alerts = [];
  for (const item of await listAlerts(auth)) {
    const alert = await getAlert(auth, item.alert_id ?? item.id);
    alerts.push(normalizeAlertExport(alert ?? item));
  }
  const path = join(generatedDir, "alerts-backup.snapshot.json");
  atomicWriteFile(
    path,
    `${JSON.stringify({ backedUpAt: new Date().toISOString(), alerts }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { path, count: alerts.length };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:backup");
    const result = await alertsBackup();
    log(`lab:alerts:backup wrote snapshot (${result.count} alerts)`);
  } catch (error) {
    logError(`lab:alerts:backup FAILED: ${error.message}`);
    process.exit(1);
  }
}
