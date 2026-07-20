import { readFileSync } from "node:fs";

import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";
import { LOCAL_DESTINATION_NAME, alertsInstallStarters } from "./alerts-install-starters.mjs";
import { assertExactLabToolchain, emailSecretPath, log, logError } from "./common.mjs";
import {
  createAlert,
  deleteAlert,
  listAlerts,
  readAdminAuthHeader,
} from "./alerts/admin-client.mjs";
import { buildOpenObserveAlert } from "./alerts/alert-builder.js";
import { loadAllAlertPolicies, loadAlertTemplates } from "./alerts/catalog.mjs";
import { decideRestoreAction } from "./alerts/guard.js";
import { recordStarterInstalled } from "./alerts/install-state.mjs";
import { parseMarker } from "./alerts/marker.js";
import { loadAllQueryManifests } from "./dashboards/catalog.mjs";

export async function alertsRestoreStarters({ confirmed }) {
  const decision = decideRestoreAction({ confirmed });
  if (!decision.allowed) return { allowed: false, reason: decision.reason, results: [] };

  const setupResults = await alertsInstallStarters();
  const auth = readAdminAuthHeader();
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const [template] = loadAlertTemplates();
  const queries = new Map(loadAllQueryManifests().map((query) => [query.id, query]));
  const policies = loadAllAlertPolicies();
  const policyIds = new Set(policies.map((policy) => policy.id));
  const restoreResults = [];

  for (const alert of await listAlerts(auth)) {
    const marker = parseMarker(alert.description);
    if (!marker || !policyIds.has(marker.starterId)) continue;
    const deleted = await deleteAlert(auth, alert.alert_id ?? alert.id);
    restoreResults.push({
      starterId: marker.starterId,
      outcome: deleted.ok ? "DELETED_FOR_RESTORE" : "DELETE_FAILED",
      status: deleted.status,
    });
  }

  for (const policy of policies) {
    const body = buildOpenObserveAlert(policy, queries.get(policy.queryId), {
      owner,
      scope: {
        service: DEMO_IDENTITY.service,
        environment: DEMO_IDENTITY.environment,
        version: DEMO_IDENTITY.version,
      },
      destinationName: LOCAL_DESTINATION_NAME,
      templateName: template.openObserveTemplateName,
    });
    const created = await createAlert(auth, body);
    if (created.status === 200) recordStarterInstalled(policy.id, policy.schemaVersion);
    restoreResults.push({
      starterId: policy.id,
      outcome: created.status === 200 ? "RESTORED" : "RESTORE_FAILED",
      status: created.status,
    });
  }

  return { allowed: true, reason: "OK", results: [...setupResults, ...restoreResults] };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:restore-starters");
    const result = await alertsRestoreStarters({ confirmed: process.argv.includes("--confirm") });
    if (!result.allowed) {
      logError(`lab:alerts:restore-starters refused: ${result.reason}`);
      process.exit(1);
    }
    log("lab:alerts:restore-starters");
    for (const item of result.results) log(`  ${item.starterId ?? item.name}: ${item.outcome}`);
  } catch (error) {
    logError(`lab:alerts:restore-starters FAILED: ${error.message}`);
    process.exit(1);
  }
}
