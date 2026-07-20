import { readFileSync } from "node:fs";

import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { listAlerts, readAdminAuthHeader } from "./alerts/admin-client.mjs";
import { decideImportAction, IMPORT_CONFLICT_POLICY } from "./alerts/guard.js";

export async function alertsImport({
  path,
  apply = false,
  conflictPolicy = IMPORT_CONFLICT_POLICY.SKIP,
}) {
  const auth = readAdminAuthHeader();
  const existing = new Set((await listAlerts(auth)).map((alert) => alert.name));
  const seen = new Set();
  const payload = path ? JSON.parse(readFileSync(path, "utf8")) : { alerts: [] };
  return (payload.alerts ?? []).map((alert) => {
    const decision = decideImportAction({
      stableId: alert.name,
      deleteRequested: alert.delete === true,
      existingStableIds: existing,
      seenStableIdsInThisImport: seen,
      conflictPolicy,
    });
    seen.add(alert.name);
    return { name: alert.name, dryRun: !apply, outcome: decision.action, reason: decision.reason };
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("lab:alerts:import");
    const apply = process.argv.includes("--apply");
    const overwrite = process.argv.includes("--conflict=overwrite");
    const path = process.argv.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
    const results = await alertsImport({
      path,
      apply,
      conflictPolicy: overwrite ? IMPORT_CONFLICT_POLICY.OVERWRITE : IMPORT_CONFLICT_POLICY.SKIP,
    });
    log(`lab:alerts:import ${apply ? "apply" : "dry-run"}`);
    for (const result of results) log(`  ${result.name}: ${result.outcome}`);
  } catch (error) {
    logError(`lab:alerts:import FAILED: ${error.message}`);
    process.exit(1);
  }
}
