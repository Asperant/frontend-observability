// `pnpm lab:dashboards:export` — reads every dashboard back via the API
// (read-back only, never trusts a cached copy), strips server-only/volatile
// fields (scripts/lab/dashboards/normalize.js), and writes a candidate
// normalized JSON snapshot to .runtime/generated/dashboard-export/<run>/ —
// gitignored, never written into infrastructure/openobserve/analytics/
// (roadmap: "Mevcut repo manifestinin üzerine otomatik yazmaz", "Git commit
// oluşturmaz"). Also reports, per starter, whether the installed dashboard's
// panel count still matches the repo manifest — informational only, not a
// diff that gets applied anywhere.

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
import { loadAllStarterDashboards } from "./dashboards/catalog.mjs";
import { parseMarker } from "./dashboards/marker.js";
import { extractDashboardBody, normalizeDashboardBody } from "./dashboards/normalize.js";

function countPanels(tabs) {
  return (tabs ?? []).reduce((total, tab) => total + (tab.panels?.length ?? 0), 0);
}

export async function dashboardsExport() {
  const auth = readAdminAuthHeader();
  const items = await collectAllDashboards(auth);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(generatedDir, "dashboard-export", runId);

  const written = [];
  for (const item of items) {
    const v3Body = extractDashboardBody(item.envelope);
    const normalized = normalizeDashboardBody(v3Body);
    const fileName = safeFileName(item.folderName, v3Body.title);
    atomicWriteFile(join(outDir, fileName), `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: 0o600,
    });
    written.push({ folderName: item.folderName, title: v3Body.title, fileName });
  }

  const starters = loadAllStarterDashboards();
  const starterDiffs = starters.map((starter) => {
    const installed = items.find(
      (item) =>
        parseMarker(extractDashboardBody(item.envelope).description)?.starterId ===
        starter.starterId,
    );
    if (!installed) return { starterId: starter.starterId, status: "NOT_INSTALLED" };
    const v3Body = extractDashboardBody(installed.envelope);
    const desiredPanelCount = starter.tabs.reduce((total, tab) => total + tab.panels.length, 0);
    const installedPanelCount = countPanels(v3Body.tabs);
    return {
      starterId: starter.starterId,
      status:
        desiredPanelCount === installedPanelCount ? "PANEL_COUNT_MATCH" : "PANEL_COUNT_DIFFERS",
      desiredPanelCount,
      installedPanelCount,
    };
  });

  return { outDir, written, starterDiffs };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:dashboards:export");
    const { outDir, written, starterDiffs } = await dashboardsExport();
    log("lab:dashboards:export");
    log(`  wrote ${written.length} dashboard(s) to ${outDir}`);
    for (const diff of starterDiffs) {
      log(`  ${diff.starterId}: ${diff.status}`);
    }
    process.exit(0);
  } catch (error) {
    logError(`lab:dashboards:export FAILED: ${error.message}`);
    process.exit(1);
  }
}
