// `pnpm lab:dashboards:audit` — read-only risk audit of every dashboard in
// every folder (starter and company-owned alike). Never writes, never
// deletes (roadmap: "Audit şirket dashboardunu silmemeli veya
// değiştirmemeli"). scripts/lab/dashboards/audit.js does the actual,
// pure classification; this script only ever reads dashboards and
// (best-effort) executes each panel's own SQL against `_search` to detect a
// live syntax/type mismatch — a panel whose SQL still contains an
// OpenObserve dashboard-variable token (`$name`, unresolved outside the
// real web UI — docs/openobserve-v0.91-dashboard-capabilities.md capability
// #13/#13a) is skipped rather than reported as broken.

import { assertExactLabToolchain, log, logError } from "./common.mjs";
import {
  listDashboards,
  listFolders,
  readAdminAuthHeader,
  search,
} from "./dashboards/admin-client.mjs";
import { auditDashboard, RISK_CLASS } from "./dashboards/audit.js";
import { extractDashboardBody } from "./dashboards/normalize.js";

const AUDIT_WINDOW_HOURS = 168;

function containsUnresolvedVariableToken(sql) {
  return /\$[a-z][a-z0-9_]*/i.test(sql);
}

async function executeQuery(auth, sql) {
  const endUs = Date.now() * 1000;
  const startUs = endUs - AUDIT_WINDOW_HOURS * 60 * 60 * 1_000_000;
  const result = await search(auth, sql, { startUs, endUs });
  return {
    status: result.status,
    error: result.status !== 200 ? JSON.stringify(result.body).slice(0, 300) : undefined,
  };
}

export async function dashboardsAudit() {
  const auth = readAdminAuthHeader();
  const folders = await listFolders(auth);
  const reports = [];

  for (const folder of folders) {
    const dashboards = await listDashboards(auth, folder.folderId);
    for (const dashboard of dashboards) {
      const dashboardBody = extractDashboardBody(dashboard);
      const queryResults = {};
      for (const tab of dashboardBody.tabs ?? []) {
        for (const panel of tab.panels ?? []) {
          for (const query of panel.queries ?? []) {
            if (containsUnresolvedVariableToken(query.query ?? "")) continue;
            queryResults[panel.id] = await executeQuery(auth, query.query);
          }
        }
      }
      const audit = auditDashboard(dashboardBody, { queryResults });
      reports.push({
        folderName: folder.name,
        dashboardId: dashboard.dashboard_id,
        title: dashboard.title,
        overall: audit.overall,
        findings: audit.findings,
      });
    }
  }

  return reports;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:dashboards:audit");
    const reports = await dashboardsAudit();
    log("lab:dashboards:audit");
    let anyRisk = false;
    for (const report of reports) {
      log(`  [${report.folderName}] ${report.title}: ${report.overall}`);
      if (report.overall !== RISK_CLASS.PASS) {
        anyRisk = true;
        for (const finding of report.findings) {
          logError(
            `    - ${finding.class}${finding.panelId ? ` (panel ${finding.panelId})` : ""}: ${finding.message}`,
          );
        }
      }
    }
    // Audit is diagnostic, not a destructive gate: it always reports, and
    // exits non-zero only to make a CI-visible risk finding hard to miss —
    // it never blocks/mutates any dashboard on its own.
    process.exit(anyRisk ? 1 : 0);
  } catch (error) {
    logError(`lab:dashboards:audit FAILED: ${error.message}`);
    process.exit(1);
  }
}
