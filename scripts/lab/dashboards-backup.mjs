// `pnpm lab:dashboards:backup` — full, secret-free, read-back snapshot of
// every dashboard in every folder (starter and company-owned alike),
// written to .runtime/generated/dashboard-backup/<run>/ with an index
// manifest. Gitignored, non-destructive, no repo file is touched, no commit
// is made — this is a disaster-recovery snapshot, not a diff tool (see
// dashboards-export.mjs for the repo-manifest-comparison variant).

import { join } from "node:path";

import {
  atomicWriteFile,
  generatedDir,
  log,
  logError,
  assertExactLabToolchain,
} from "./common.mjs";
import { readAdminAuthHeader } from "./dashboards/admin-client.mjs";
import { collectAllDashboards, safeFileName } from "./dashboards/collect.mjs";
import { parseMarker } from "./dashboards/marker.js";
import { extractDashboardBody, normalizeDashboardBody } from "./dashboards/normalize.js";

export async function dashboardsBackup() {
  const auth = readAdminAuthHeader();
  const items = await collectAllDashboards(auth);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(generatedDir, "dashboard-backup", runId);

  const index = [];
  for (const item of items) {
    const v3Body = extractDashboardBody(item.envelope);
    const normalized = normalizeDashboardBody(v3Body);
    const fileName = safeFileName(item.folderName, v3Body.title);
    atomicWriteFile(join(outDir, fileName), `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: 0o600,
    });
    index.push({
      folderName: item.folderName,
      title: v3Body.title,
      fileName,
      managed: parseMarker(v3Body.description) !== null,
    });
  }

  atomicWriteFile(
    join(outDir, "index.json"),
    `${JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), dashboards: index }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { outDir, index };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:dashboards:backup");
    const { outDir, index } = await dashboardsBackup();
    log("lab:dashboards:backup");
    log(`  backed up ${index.length} dashboard(s) to ${outDir}`);
    process.exit(0);
  } catch (error) {
    logError(`lab:dashboards:backup FAILED: ${error.message}`);
    process.exit(1);
  }
}
