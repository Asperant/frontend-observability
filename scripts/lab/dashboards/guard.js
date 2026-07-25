// Pure decision logic for every write-capable dashboard-governance dashboard operation
// (install-starters, restore-starters, import). No I/O: callers
// (scripts/lab/dashboards-*.mjs) are responsible for actually performing or
// refusing the API call based on this module's verdict — mirroring
// scripts/lab/streams/guard.js's own split for stream-lifecycle.

import { parseMarker } from "./marker.js";

export const INSTALL_ACTION = Object.freeze({
  CREATE: "CREATE",
  NO_CHANGE_ALREADY_INSTALLED: "NO_CHANGE_ALREADY_INSTALLED",
  SKIP_INSTALLED_DIFFERENT_VERSION: "SKIP_INSTALLED_DIFFERENT_VERSION",
  SKIP_TITLE_COLLISION_UNMANAGED: "SKIP_TITLE_COLLISION_UNMANAGED",
  SKIP_PREVIOUSLY_DELETED_BY_COMPANY: "SKIP_PREVIOUSLY_DELETED_BY_COMPANY",
});

/**
 * Decides what install-starters should do for one desired starter dashboard,
 * given the dashboards already present in its target folder and this
 * stage's own local install-state record (scripts/lab/dashboards-install-starters.mjs's
 * install-state.json — the only way to tell "never installed yet" apart
 * from "installed once, then deleted by the company", since OpenObserve
 * itself keeps no tombstone once a dashboard is deleted — capability #9).
 * Never recommends an overwrite or delete — a marker-version mismatch, an
 * unmanaged title collision, or a company deletion are all reported for a
 * human/restore-starters to resolve, never silently applied here (roadmap:
 * "Mevcut dashboardu overwrite etmez", "Şirket tarafından silinmiş
 * dashboardu normal çalışmada geri oluşturmaz").
 */
export function decideInstallAction({
  desiredStarterId,
  desiredVersion,
  desiredTitle,
  existingDashboards,
  previouslyInstalledVersion = null,
}) {
  for (const dashboard of existingDashboards) {
    const marker = parseMarker(dashboard.description);
    if (marker && marker.starterId === desiredStarterId) {
      if (marker.starterVersion === desiredVersion) {
        return {
          action: INSTALL_ACTION.NO_CHANGE_ALREADY_INSTALLED,
          reason: "MARKER_VERSION_MATCH",
        };
      }
      return {
        action: INSTALL_ACTION.SKIP_INSTALLED_DIFFERENT_VERSION,
        reason: `installed marker version v${marker.starterVersion} differs from desired v${desiredVersion}; run lab:dashboards:restore-starters --confirm to reset`,
      };
    }
  }

  if (previouslyInstalledVersion !== null) {
    return {
      action: INSTALL_ACTION.SKIP_PREVIOUSLY_DELETED_BY_COMPANY,
      reason: `previously installed as v${previouslyInstalledVersion} but no longer present — respecting the deletion; run lab:dashboards:restore-starters --confirm to recreate`,
    };
  }

  const titleCollision = existingDashboards.some(
    (dashboard) => dashboard.title === desiredTitle && parseMarker(dashboard.description) === null,
  );
  if (titleCollision) {
    return {
      action: INSTALL_ACTION.SKIP_TITLE_COLLISION_UNMANAGED,
      reason: "an unmanaged (company-created) dashboard already uses this exact title",
    };
  }

  return { action: INSTALL_ACTION.CREATE, reason: "OK" };
}

export function previouslyInstalledVersion(installState, starterId) {
  return installState?.installedStarters?.[starterId]?.version ?? null;
}

export function decideRestoreAction({ confirmed }) {
  if (confirmed !== true) return { allowed: false, reason: "CONFIRMATION_REQUIRED" };
  return { allowed: true, reason: "OK" };
}

export const IMPORT_CONFLICT_POLICY = Object.freeze({ SKIP: "skip", OVERWRITE: "overwrite" });

export const IMPORT_ACTION = Object.freeze({
  CREATE: "CREATE",
  SKIP_EXISTING_TITLE: "SKIP_EXISTING_TITLE",
  OVERWRITE_EXISTING_TITLE: "OVERWRITE_EXISTING_TITLE",
  REFUSED_DUPLICATE_TITLE_IN_IMPORT_SET: "REFUSED_DUPLICATE_TITLE_IN_IMPORT_SET",
  REFUSED_UNKNOWN_CONFLICT_POLICY: "REFUSED_UNKNOWN_CONFLICT_POLICY",
});

/**
 * Decides what import should do for one candidate dashboard title, given
 * the dashboards already present in the target folder and the caller's
 * explicit conflict policy (defaults closed: an unknown/unset policy other
 * than "skip"/"overwrite" is refused outright, never treated as permissive).
 */
export function decideImportAction({
  title,
  existingDashboards,
  conflictPolicy,
  seenTitlesInThisImport,
}) {
  if (
    conflictPolicy !== IMPORT_CONFLICT_POLICY.SKIP &&
    conflictPolicy !== IMPORT_CONFLICT_POLICY.OVERWRITE
  ) {
    return {
      action: IMPORT_ACTION.REFUSED_UNKNOWN_CONFLICT_POLICY,
      reason: `unknown conflictPolicy: ${conflictPolicy}`,
    };
  }
  if (seenTitlesInThisImport.has(title)) {
    return {
      action: IMPORT_ACTION.REFUSED_DUPLICATE_TITLE_IN_IMPORT_SET,
      reason: "duplicate title within the import batch itself",
    };
  }
  const existing = existingDashboards.find((dashboard) => dashboard.title === title);
  if (!existing) return { action: IMPORT_ACTION.CREATE, reason: "OK" };
  if (conflictPolicy === IMPORT_CONFLICT_POLICY.OVERWRITE) {
    return {
      action: IMPORT_ACTION.OVERWRITE_EXISTING_TITLE,
      reason: "OK",
      existingDashboardId: existing.dashboardId,
    };
  }
  return { action: IMPORT_ACTION.SKIP_EXISTING_TITLE, reason: "conflictPolicy is skip" };
}
