// Shared read-only collection of every dashboard in every folder. Pure I/O
// (not unit-coverage-gated) — used by both dashboards-export.mjs and
// dashboards-backup.mjs so they read/normalize identically.

import { listDashboards, listFolders } from "./admin-client.mjs";

export async function collectAllDashboards(auth) {
  const folders = await listFolders(auth);
  const items = [];
  for (const folder of folders) {
    const dashboards = await listDashboards(auth, folder.folderId);
    for (const dashboard of dashboards) {
      items.push({ folderName: folder.name, folderId: folder.folderId, envelope: dashboard });
    }
  }
  return items;
}

export function safeFileName(folderName, title) {
  const raw = `${folderName}__${title}`.toLowerCase();
  return `${raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")}.json`;
}
