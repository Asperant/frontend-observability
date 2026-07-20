import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { getAlert, listAlerts, readAdminAuthHeader } from "./alerts/admin-client.mjs";
import { auditAlertDefinition } from "./alerts/audit.js";

export async function alertsAudit() {
  const auth = readAdminAuthHeader();
  const summaries = [];
  for (const item of await listAlerts(auth)) {
    const alert = await getAlert(auth, item.alert_id ?? item.id);
    summaries.push({ name: item.name, ...auditAlertDefinition(alert ?? item) });
  }
  return summaries;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:audit");
    const summaries = await alertsAudit();
    log("lab:alerts:audit");
    for (const summary of summaries) {
      log(`  ${summary.name}: ${summary.class} (${summary.findings.length} findings)`);
    }
  } catch (error) {
    logError(`lab:alerts:audit FAILED: ${error.message}`);
    process.exit(1);
  }
}
