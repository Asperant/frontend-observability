// `pnpm lab:dashboards:status` — read-only summary of every starter
// dashboard's install state (folder existence, marker/version match,
// company/unmanaged dashboards sharing the same folder), plus a per-folder
// dashboard count across every folder OpenObserve reports. Never writes.

import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { listDashboards, listFolders, readAdminAuthHeader } from "./dashboards/admin-client.mjs";
import { loadAllStarterDashboards } from "./dashboards/catalog.mjs";
import { parseMarker } from "./dashboards/marker.js";

export async function dashboardsStatus() {
  const auth = readAdminAuthHeader();
  const starters = loadAllStarterDashboards();
  const folders = await listFolders(auth);

  const starterResults = [];
  for (const starter of starters) {
    const folder = folders.find((candidate) => candidate.name === starter.folderName);
    if (!folder) {
      starterResults.push({ starterId: starter.starterId, status: "FOLDER_MISSING" });
      continue;
    }
    const dashboards = await listDashboards(auth, folder.folderId);
    const managed = dashboards.find(
      (dashboard) => parseMarker(dashboard.description)?.starterId === starter.starterId,
    );
    if (!managed) {
      starterResults.push({
        starterId: starter.starterId,
        status: "NOT_INSTALLED",
        folderId: folder.folderId,
      });
      continue;
    }
    const marker = parseMarker(managed.description);
    starterResults.push({
      starterId: starter.starterId,
      status:
        marker.starterVersion === starter.starterVersion
          ? "INSTALLED_CURRENT"
          : "INSTALLED_STALE_VERSION",
      installedVersion: marker.starterVersion,
      desiredVersion: starter.starterVersion,
      dashboardId: managed.dashboard_id,
      folderId: folder.folderId,
    });
  }

  const folderSummaries = [];
  for (const folder of folders) {
    const dashboards = await listDashboards(auth, folder.folderId);
    const managedCount = dashboards.filter(
      (dashboard) => parseMarker(dashboard.description) !== null,
    ).length;
    folderSummaries.push({
      folderId: folder.folderId,
      folderName: folder.name,
      dashboardCount: dashboards.length,
      managedCount,
      unmanagedCount: dashboards.length - managedCount,
    });
  }

  return { starters: starterResults, folders: folderSummaries };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:dashboards:status");
    const { starters, folders } = await dashboardsStatus();
    log("lab:dashboards:status");
    log("  starters:");
    for (const starter of starters) {
      log(`    ${starter.starterId}: ${starter.status}`);
    }
    log("  folders:");
    for (const folder of folders) {
      log(
        `    ${folder.folderName}: ${folder.dashboardCount} dashboard(s) (${folder.managedCount} managed, ${folder.unmanagedCount} unmanaged)`,
      );
    }
    process.exit(0);
  } catch (error) {
    logError(`lab:dashboards:status FAILED: ${error.message}`);
    process.exit(1);
  }
}
