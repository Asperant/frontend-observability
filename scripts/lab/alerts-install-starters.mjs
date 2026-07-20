import { readFileSync } from "node:fs";

import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";
import { assertExactLabToolchain, emailSecretPath, log, logError } from "./common.mjs";
import {
  createAlert,
  createLocalDestination,
  createTemplate,
  listAlerts,
  listDestinations,
  listTemplates,
  readAdminAuthHeader,
} from "./alerts/admin-client.mjs";
import { buildOpenObserveAlert } from "./alerts/alert-builder.js";
import { loadAllAlertPolicies, loadAlertTemplates } from "./alerts/catalog.mjs";
import { decideInstallAction, INSTALL_ACTION, previouslyInstalledVersion } from "./alerts/guard.js";
import { readInstallState, recordStarterInstalled } from "./alerts/install-state.mjs";
import { loadAllQueryManifests } from "./dashboards/catalog.mjs";

export const LOCAL_DESTINATION_NAME = "chicek-stage17-local-alert-sink";

async function ensureTemplate(auth, template) {
  const existing = await listTemplates(auth);
  if (existing.some((item) => item.name === template.openObserveTemplateName)) {
    return { outcome: "TEMPLATE_EXISTS", name: template.openObserveTemplateName };
  }
  const result = await createTemplate(auth, template);
  return {
    outcome: result.status === 200 ? "TEMPLATE_CREATED" : "TEMPLATE_CREATE_FAILED",
    status: result.status,
    name: template.openObserveTemplateName,
  };
}

async function ensureDestination(auth, templateName) {
  const existing = await listDestinations(auth);
  if (existing.some((item) => item.name === LOCAL_DESTINATION_NAME)) {
    return { outcome: "DESTINATION_EXISTS", name: LOCAL_DESTINATION_NAME };
  }
  const result = await createLocalDestination(auth, {
    name: LOCAL_DESTINATION_NAME,
    templateName,
  });
  return {
    outcome: result.status === 200 ? "DESTINATION_CREATED" : "DESTINATION_CREATE_FAILED",
    status: result.status,
    name: LOCAL_DESTINATION_NAME,
  };
}

export async function alertsInstallStarters() {
  const auth = readAdminAuthHeader();
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const [template] = loadAlertTemplates();
  const templateResult = await ensureTemplate(auth, template);
  const destinationResult = await ensureDestination(auth, template.openObserveTemplateName);
  const policies = loadAllAlertPolicies();
  const queries = new Map(loadAllQueryManifests().map((query) => [query.id, query]));
  const installState = readInstallState();
  const existingAlerts = await listAlerts(auth);
  const results = [templateResult, destinationResult];

  for (const policy of policies) {
    const decision = decideInstallAction({
      desiredStarterId: policy.id,
      desiredVersion: policy.schemaVersion,
      desiredName: policy.id,
      existingAlerts,
      previouslyInstalledVersion: previouslyInstalledVersion(installState, policy.id),
    });

    if (decision.action !== INSTALL_ACTION.CREATE) {
      if (decision.action === INSTALL_ACTION.NO_CHANGE_ALREADY_INSTALLED) {
        recordStarterInstalled(policy.id, policy.schemaVersion);
      }
      results.push({ starterId: policy.id, outcome: decision.action, reason: decision.reason });
      continue;
    }

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
    if (created.status === 200) {
      recordStarterInstalled(policy.id, policy.schemaVersion);
      results.push({ starterId: policy.id, outcome: "CREATED" });
    } else {
      results.push({ starterId: policy.id, outcome: "CREATE_FAILED", status: created.status });
    }
  }

  return results;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:install-starters");
    const results = await alertsInstallStarters();
    log("lab:alerts:install-starters");
    let failed = false;
    for (const result of results) {
      log(
        `  ${result.starterId ?? result.name}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`,
      );
      if (String(result.outcome).endsWith("FAILED")) failed = true;
    }
    process.exit(failed ? 1 : 0);
  } catch (error) {
    logError(`lab:alerts:install-starters FAILED: ${error.message}`);
    process.exit(1);
  }
}
