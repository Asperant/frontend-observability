// `pnpm lab:dashboards:restore-starters --confirm` — explicit, human-invoked
// reset of every starter dashboard to its current repo manifest definition:
// deletes the existing marker-managed copy (if any) and recreates it fresh.
// Requires `--confirm` (scripts/lab/dashboards/guard.js's
// decideRestoreAction) and is never run by install-starters, lab:up,
// lab:verify, or any other normal provision/verify chain (roadmap: "Bu komut
// normal provision/verify zincirinde çalışmamalı"). Only ever deletes a
// dashboard whose own marker.starterId matches the starter being restored —
// never an unmanaged/company dashboard, even one with a colliding title.

import { readFileSync } from "node:fs";

import { assertExactLabToolchain, emailSecretPath, log, logError } from "./common.mjs";
import {
  createDashboard,
  createFolder,
  deleteDashboard,
  getDashboard,
  listDashboards,
  listFolders,
  readAdminAuthHeader,
} from "./dashboards/admin-client.mjs";
import { loadAllQueryManifests, loadAllStarterDashboards } from "./dashboards/catalog.mjs";
import { decideRestoreAction } from "./dashboards/guard.js";
import { recordStarterInstalled } from "./dashboards/install-state.mjs";
import { parseMarker } from "./dashboards/marker.js";
import { extractDashboardBody } from "./dashboards/normalize.js";
import { buildStarterDashboardBody } from "./dashboards/panel-builder.js";
import { DashboardVariableToken } from "./dashboards/sql-template.js";
import { DEMO_IDENTITY } from "../../tests/fixtures/apps/browser-app/src/identity.js";

async function findOrCreateFolder(auth, name) {
  const existing = (await listFolders(auth)).find((folder) => folder.name === name);
  if (existing) return existing.folderId;
  const result = await createFolder(auth, {
    name,
    description: "CHICEK dashboard-governance starter dashboards",
  });
  if (result.status === 200) return result.body.folderId;
  const retry = (await listFolders(auth)).find((folder) => folder.name === name);
  if (retry) return retry.folderId;
  throw new Error(`unable to find or create folder '${name}' (status ${result.status}).`);
}

function variablesFor(starterId) {
  if (starterId === "session-investigation") {
    // session_id stays a $-token for the exact-match drilldown panel; the
    // Recent sessions tab's list panel is a normal service/environment
    // query like every other starter's, so both must be supplied together.
    return {
      session_id: new DashboardVariableToken("session_id"),
      service: DEMO_IDENTITY.service,
      environment: DEMO_IDENTITY.environment,
    };
  }
  return { service: DEMO_IDENTITY.service, environment: DEMO_IDENTITY.environment };
}

export async function dashboardsRestoreStarters({ confirmed }) {
  const decision = decideRestoreAction({ confirmed });
  if (!decision.allowed) {
    return { allowed: false, reason: decision.reason, results: [] };
  }

  const auth = readAdminAuthHeader();
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const starters = loadAllStarterDashboards();
  const queryManifestsById = new Map(
    loadAllQueryManifests().map((manifest) => [manifest.id, manifest]),
  );
  const results = [];

  for (const starter of starters) {
    const folderId = await findOrCreateFolder(auth, starter.folderName);
    const existingDashboards = await listDashboards(auth, folderId);
    const managed = existingDashboards.find(
      (dashboard) => parseMarker(dashboard.description)?.starterId === starter.starterId,
    );

    if (managed) {
      const deletion = await deleteDashboard(auth, managed.dashboard_id, folderId);
      if (!deletion.ok) {
        results.push({
          starterId: starter.starterId,
          outcome: "DELETE_FAILED",
          status: deletion.status,
        });
        continue;
      }
    }

    const body = buildStarterDashboardBody(
      starter,
      queryManifestsById,
      variablesFor(starter.starterId),
      {
        owner,
        createdAt: new Date().toISOString(),
      },
    );
    const created = await createDashboard(auth, folderId, body);
    if (created.status !== 200) {
      results.push({
        starterId: starter.starterId,
        outcome: "RECREATE_FAILED",
        status: created.status,
      });
      continue;
    }

    const dashboardId = extractDashboardBody(created.body).dashboardId;
    const readBack = await getDashboard(auth, dashboardId, folderId);
    recordStarterInstalled(starter.starterId, starter.starterVersion);
    results.push({
      starterId: starter.starterId,
      outcome: readBack ? "RESTORED" : "RESTORED_BUT_READBACK_MISSING",
      dashboardId,
      folderId,
      hadPriorManagedCopy: Boolean(managed),
    });
  }

  return { allowed: true, results };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:dashboards:restore-starters");
    const confirmed = process.argv.includes("--confirm");
    const { allowed, reason, results } = await dashboardsRestoreStarters({ confirmed });
    if (!allowed) {
      logError(`lab:dashboards:restore-starters refused: ${reason} — pass --confirm to proceed.`);
      process.exit(1);
    }
    log("lab:dashboards:restore-starters");
    let failed = false;
    for (const result of results) {
      log(`  ${result.starterId}: ${result.outcome}`);
      if (result.outcome === "DELETE_FAILED" || result.outcome === "RECREATE_FAILED") failed = true;
    }
    process.exit(failed ? 1 : 0);
  } catch (error) {
    logError(`lab:dashboards:restore-starters FAILED: ${error.message}`);
    process.exit(1);
  }
}
