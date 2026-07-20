// `pnpm lab:dashboards:import` — validates a directory of normalized
// dashboard JSON files (scripts/lab/dashboards/normalize.js's shape, e.g.
// produced by lab:dashboards:export/backup) and, only with `--apply`,
// creates/updates them in a target folder. Defaults are closed: dry-run
// unless `--apply` is passed, and `--conflict-policy=skip` (never
// overwrite/delete an existing title) unless the caller explicitly passes
// `--conflict-policy=overwrite` — see scripts/lab/dashboards/guard.js's
// decideImportAction for the exact, pure decision logic this script only
// ever executes. Never deletes anything.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  assertExactLabToolchain,
  emailSecretPath,
  generatedDir,
  log,
  logError,
} from "./common.mjs";
import {
  createDashboard,
  createFolder,
  getDashboard,
  listDashboards,
  listFolders,
  readAdminAuthHeader,
  updateDashboard,
} from "./dashboards/admin-client.mjs";
import { decideImportAction, IMPORT_ACTION, IMPORT_CONFLICT_POLICY } from "./dashboards/guard.js";
import {
  denormalizeForCreate,
  denormalizeForUpdate,
  extractDashboardBody,
} from "./dashboards/normalize.js";

function parseArgs(argv) {
  const flags = {
    apply: argv.includes("--apply"),
    conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
    dir: null,
    folder: "CHICEK Starters",
  };
  for (const arg of argv) {
    if (arg.startsWith("--dir=")) flags.dir = arg.slice("--dir=".length);
    if (arg.startsWith("--folder=")) flags.folder = arg.slice("--folder=".length);
    if (arg.startsWith("--conflict-policy="))
      flags.conflictPolicy = arg.slice("--conflict-policy=".length);
  }
  return flags;
}

async function findOrCreateFolder(auth, name) {
  const existing = (await listFolders(auth)).find((folder) => folder.name === name);
  if (existing) return existing.folderId;
  const result = await createFolder(auth, { name, description: "Stage 16 import target" });
  if (result.status === 200) return result.body.folderId;
  const retry = (await listFolders(auth)).find((folder) => folder.name === name);
  if (retry) return retry.folderId;
  throw new Error(`unable to find or create folder '${name}' (status ${result.status}).`);
}

export async function dashboardsImport({ dir, folderName, conflictPolicy, apply }) {
  const auth = readAdminAuthHeader();
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const fileNames = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const candidates = fileNames.map((name) => ({
    fileName: name,
    normalized: JSON.parse(readFileSync(join(dir, name), "utf8")),
  }));

  // A dry-run must still reflect real conflicts, so it always reads the
  // target folder's current dashboards (read-only) — only the folder
  // *create* and the dashboard create/update calls themselves are gated on
  // `apply`, never the planning read.
  const existingFolder = (await listFolders(auth)).find((folder) => folder.name === folderName);
  const folderId = apply
    ? (existingFolder?.folderId ?? (await findOrCreateFolder(auth, folderName)))
    : (existingFolder?.folderId ?? null);
  const existingDashboards = folderId
    ? (await listDashboards(auth, folderId)).map((dashboard) => ({
        title: dashboard.title,
        dashboardId: dashboard.dashboard_id,
      }))
    : [];

  const seenTitles = new Set();
  const results = [];
  for (const candidate of candidates) {
    const decision = decideImportAction({
      title: candidate.normalized.title,
      existingDashboards,
      conflictPolicy,
      seenTitlesInThisImport: seenTitles,
    });
    seenTitles.add(candidate.normalized.title);

    if (!apply) {
      results.push({
        fileName: candidate.fileName,
        title: candidate.normalized.title,
        plannedAction: decision.action,
      });
      continue;
    }

    if (
      decision.action === IMPORT_ACTION.SKIP_EXISTING_TITLE ||
      decision.action === IMPORT_ACTION.REFUSED_DUPLICATE_TITLE_IN_IMPORT_SET ||
      decision.action === IMPORT_ACTION.REFUSED_UNKNOWN_CONFLICT_POLICY
    ) {
      results.push({
        fileName: candidate.fileName,
        title: candidate.normalized.title,
        outcome: decision.action,
        reason: decision.reason,
      });
      continue;
    }

    if (decision.action === IMPORT_ACTION.CREATE) {
      const body = denormalizeForCreate(candidate.normalized, {
        owner,
        createdAt: new Date().toISOString(),
      });
      const created = await createDashboard(auth, folderId, body);
      results.push({
        fileName: candidate.fileName,
        title: candidate.normalized.title,
        outcome: created.status === 200 ? "CREATED" : "CREATE_FAILED",
      });
      continue;
    }

    if (decision.action === IMPORT_ACTION.OVERWRITE_EXISTING_TITLE) {
      const existingEnvelope = await getDashboard(auth, decision.existingDashboardId, folderId);
      const existingV3 = extractDashboardBody(existingEnvelope);
      const body = denormalizeForUpdate(candidate.normalized, existingV3);
      const updated = await updateDashboard(
        auth,
        decision.existingDashboardId,
        folderId,
        body,
        existingEnvelope.hash,
      );
      results.push({
        fileName: candidate.fileName,
        title: candidate.normalized.title,
        outcome: updated.status === 200 ? "OVERWRITTEN" : "OVERWRITE_FAILED",
      });
    }
  }

  return { apply, folderName, conflictPolicy, results };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:dashboards:import");
    const flags = parseArgs(process.argv.slice(2));
    const dir = flags.dir ?? join(generatedDir, "dashboard-import");
    const { apply, folderName, conflictPolicy, results } = await dashboardsImport({
      dir,
      folderName: flags.folder,
      conflictPolicy: flags.conflictPolicy,
      apply: flags.apply,
    });
    log(
      `lab:dashboards:import (${apply ? "APPLY" : "DRY-RUN"}, folder='${folderName}', conflictPolicy='${conflictPolicy}')`,
    );
    let failed = false;
    for (const result of results) {
      log(
        `  ${result.fileName}: ${result.plannedAction ?? result.outcome}${result.reason ? ` (${result.reason})` : ""}`,
      );
      if (result.outcome === "CREATE_FAILED" || result.outcome === "OVERWRITE_FAILED")
        failed = true;
    }
    process.exit(failed ? 1 : 0);
  } catch (error) {
    logError(`lab:dashboards:import FAILED: ${error.message}`);
    process.exit(1);
  }
}
