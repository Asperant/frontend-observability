import { assertExactLabToolchain, log, logError } from "./common.mjs";
import {
  alertSinkControl,
  readAdminAuthHeader,
  testLocalDestination,
} from "./alerts/admin-client.mjs";

export async function alertsTestNotification() {
  const auth = readAdminAuthHeader();
  alertSinkControl("reset");
  const firing = await testLocalDestination(auth, {
    alert: "stage17-notification-probe",
    severity: "low",
    status: "firing",
    service: "probe",
    environment: "lab",
    version: "probe",
    measuredValue: "1",
    threshold: "1",
    sampleSize: "1",
    evaluationWindow: "1m",
    firingTime: new Date().toISOString(),
    dashboardRef: "probe",
    runbookRef: "probe",
    dedupKey: "probe",
  });
  const resolved = await testLocalDestination(auth, {
    alert: "stage17-notification-probe",
    severity: "low",
    status: "resolved",
    service: "probe",
    environment: "lab",
    dedupKey: "probe",
  });
  const events = alertSinkControl("events");
  alertSinkControl("disable");
  const failed = await testLocalDestination(auth, {
    alert: "stage17-notification-probe",
    status: "firing",
  });
  alertSinkControl("enable");
  return {
    firingOk: firing.body?.success === true,
    resolvedOk: resolved.body?.success === true,
    eventCount: events.count,
    failureVisible: failed.body?.success === false,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:test-notification");
    const result = await alertsTestNotification();
    log(
      `lab:alerts:test-notification firing=${result.firingOk} resolved=${result.resolvedOk} count=${result.eventCount} failureVisible=${result.failureVisible}`,
    );
    process.exit(
      result.firingOk && result.resolvedOk && result.eventCount >= 2 && result.failureVisible
        ? 0
        : 1,
    );
  } catch (error) {
    logError(`lab:alerts:test-notification FAILED: ${error.message}`);
    process.exit(1);
  }
}
