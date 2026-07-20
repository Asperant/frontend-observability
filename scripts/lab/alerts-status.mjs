import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { listAlerts, readAdminAuthHeader } from "./alerts/admin-client.mjs";
import { parseMarker } from "./alerts/marker.js";

export async function alertsStatus() {
  const auth = readAdminAuthHeader();
  const alerts = await listAlerts(auth);
  const starters = alerts.filter((alert) => parseMarker(alert.description));
  return {
    total: alerts.length,
    starters: starters.length,
    company: alerts.length - starters.length,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:status");
    const status = await alertsStatus();
    log(
      `lab:alerts:status total=${status.total} starters=${status.starters} company=${status.company}`,
    );
  } catch (error) {
    logError(`lab:alerts:status FAILED: ${error.message}`);
    process.exit(1);
  }
}
