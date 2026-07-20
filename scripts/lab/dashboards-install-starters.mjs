// `pnpm lab:dashboards:install-starters` — creates any starter dashboard
// (infrastructure/openobserve/analytics/dashboards/*.dashboard.json) that
// does not already exist yet, identified by a stable marker embedded in its
// `description` (scripts/lab/dashboards/marker.js — dashboardId itself is
// always server-assigned and not portable, see
// docs/openobserve-v0.91-dashboard-capabilities.md capability #9a). Never
// overwrites an existing dashboard (marker-matched or an unmanaged title
// collision) and never deletes anything — see
// scripts/lab/dashboards/guard.js's decideInstallAction for the exact,
// pure decision logic this script only ever executes.

import { readFileSync } from "node:fs";

import { assertExactLabToolchain, emailSecretPath, log, logError } from "./common.mjs";
import {
  createDashboard,
  createFolder,
  getDashboard,
  listDashboards,
  listFolders,
  readAdminAuthHeader,
} from "./dashboards/admin-client.mjs";
import { loadAllQueryManifests, loadAllStarterDashboards } from "./dashboards/catalog.mjs";
import {
  decideInstallAction,
  INSTALL_ACTION,
  previouslyInstalledVersion,
} from "./dashboards/guard.js";
import { readInstallState, recordStarterInstalled } from "./dashboards/install-state.mjs";
import { parseMarker } from "./dashboards/marker.js";
import { buildStarterDashboardBody } from "./dashboards/panel-builder.js";
import { DashboardVariableToken } from "./dashboards/sql-template.js";
import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";

const FOLDER_DESCRIPTION =
  "CHICEK Stage 16 starter dashboards — see docs/openobserve-query-dashboard-governance.md";

async function findOrCreateFolder(auth, name) {
  const existing = (await listFolders(auth)).find((folder) => folder.name === name);
  if (existing) return existing.folderId;

  const result = await createFolder(auth, { name, description: FOLDER_DESCRIPTION });
  if (result.status === 200) return result.body.folderId;
  if (result.status === 400) {
    // Folder names are unique server-side (docs/openobserve-v0.91-dashboard-capabilities.md
    // capability #2) — a 400 here almost always means a concurrent run (or a
    // prior partial run) already created it; re-list rather than fail.
    const retry = (await listFolders(auth)).find((folder) => folder.name === name);
    if (retry) return retry.folderId;
  }
  throw new Error(`unable to find or create folder '${name}' (status ${result.status}).`);
}

function variablesFor(starterId) {
  if (starterId === "session-investigation") {
    return { session_id: new DashboardVariableToken("session_id") };
  }
  return { service: DEMO_IDENTITY.service, environment: DEMO_IDENTITY.environment };
}

function countPanels(tabs) {
  return tabs.reduce((total, tab) => total + tab.panels.length, 0);
}

export async function dashboardsInstallStarters() {
  const auth = readAdminAuthHeader();
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const starters = loadAllStarterDashboards();
  const queryManifestsById = new Map(
    loadAllQueryManifests().map((manifest) => [manifest.id, manifest]),
  );
  const installState = readInstallState();
  const results = [];

  for (const starter of starters) {
    const folderId = await findOrCreateFolder(auth, starter.folderName);
    const existingDashboards = await listDashboards(auth, folderId);
    const decision = decideInstallAction({
      desiredStarterId: starter.starterId,
      desiredVersion: starter.starterVersion,
      desiredTitle: starter.title,
      existingDashboards: existingDashboards.map((dashboard) => ({
        title: dashboard.title,
        description: dashboard.description,
      })),
      previouslyInstalledVersion: previouslyInstalledVersion(installState, starter.starterId),
    });

    if (decision.action !== INSTALL_ACTION.CREATE) {
      // A currently-installed, marker-version-matched starter keeps the
      // local install-state record in sync even if this is the very first
      // run to observe it (e.g. state was reset, or this starter predates
      // install-state tracking) — otherwise a later company deletion could
      // never be told apart from "never installed".
      if (decision.action === INSTALL_ACTION.NO_CHANGE_ALREADY_INSTALLED) {
        recordStarterInstalled(starter.starterId, starter.starterVersion);
      }
      results.push({
        starterId: starter.starterId,
        outcome: decision.action,
        reason: decision.reason,
      });
      continue;
    }

    const variables = variablesFor(starter.starterId);
    const body = buildStarterDashboardBody(starter, queryManifestsById, variables, {
      owner,
      createdAt: new Date().toISOString(),
    });

    const created = await createDashboard(auth, folderId, body);
    if (created.status !== 200) {
      results.push({
        starterId: starter.starterId,
        outcome: "CREATE_FAILED",
        status: created.status,
      });
      continue;
    }

    const dashboardId = created.body.v3.dashboardId;
    const readBack = await getDashboard(auth, dashboardId, folderId);
    const marker = readBack ? parseMarker(readBack.v3.description) : null;
    const readBackOk =
      readBack !== null &&
      readBack.v3.title === starter.title &&
      marker?.starterId === starter.starterId &&
      marker?.starterVersion === starter.starterVersion &&
      countPanels(readBack.v3.tabs) === countPanels(body.tabs);

    recordStarterInstalled(starter.starterId, starter.starterVersion);

    results.push({
      starterId: starter.starterId,
      outcome: readBackOk ? "CREATED" : "CREATED_BUT_READBACK_MISMATCH",
      dashboardId,
      folderId,
      panelCount: countPanels(body.tabs),
    });
  }

  return results;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:dashboards:install-starters");
    const results = await dashboardsInstallStarters();
    log("lab:dashboards:install-starters");
    let failed = false;
    for (const result of results) {
      log(`  ${result.starterId}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
      if (
        result.outcome === "CREATE_FAILED" ||
        result.outcome === "CREATED_BUT_READBACK_MISMATCH"
      ) {
        failed = true;
      }
    }
    process.exit(failed ? 1 : 0);
  } catch (error) {
    logError(`lab:dashboards:install-starters FAILED: ${error.message}`);
    process.exit(1);
  }
}
