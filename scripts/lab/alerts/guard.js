import { parseMarker } from "./marker.js";

export const INSTALL_ACTION = Object.freeze({
  CREATE: "CREATE",
  NO_CHANGE_ALREADY_INSTALLED: "NO_CHANGE_ALREADY_INSTALLED",
  SKIP_INSTALLED_DIFFERENT_VERSION: "SKIP_INSTALLED_DIFFERENT_VERSION",
  SKIP_NAME_COLLISION_UNMANAGED: "SKIP_NAME_COLLISION_UNMANAGED",
  SKIP_PREVIOUSLY_DELETED_BY_COMPANY: "SKIP_PREVIOUSLY_DELETED_BY_COMPANY",
});

export function decideInstallAction({
  desiredStarterId,
  desiredVersion,
  desiredName,
  existingAlerts,
  previouslyInstalledVersion = null,
}) {
  for (const alert of existingAlerts) {
    const marker = parseMarker(alert.description);
    if (marker?.starterId === desiredStarterId) {
      if (marker.starterVersion === desiredVersion) {
        return {
          action: INSTALL_ACTION.NO_CHANGE_ALREADY_INSTALLED,
          reason: "MARKER_VERSION_MATCH",
        };
      }
      return {
        action: INSTALL_ACTION.SKIP_INSTALLED_DIFFERENT_VERSION,
        reason: "installed starter marker version differs from desired version",
      };
    }
  }

  if (previouslyInstalledVersion !== null) {
    return {
      action: INSTALL_ACTION.SKIP_PREVIOUSLY_DELETED_BY_COMPANY,
      reason: "previously installed but no longer present",
    };
  }

  const nameCollision = existingAlerts.some(
    (alert) => alert.name === desiredName && parseMarker(alert.description) === null,
  );
  if (nameCollision) {
    return {
      action: INSTALL_ACTION.SKIP_NAME_COLLISION_UNMANAGED,
      reason: "unmanaged alert already uses this name",
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
  SKIP_EXISTING_STABLE_ID: "SKIP_EXISTING_STABLE_ID",
  OVERWRITE_EXISTING_STABLE_ID: "OVERWRITE_EXISTING_STABLE_ID",
  REFUSED_DELETE: "REFUSED_DELETE",
  REFUSED_DUPLICATE_STABLE_ID_IN_IMPORT_SET: "REFUSED_DUPLICATE_STABLE_ID_IN_IMPORT_SET",
  REFUSED_UNKNOWN_CONFLICT_POLICY: "REFUSED_UNKNOWN_CONFLICT_POLICY",
});

export function decideImportAction({
  stableId,
  deleteRequested = false,
  existingStableIds,
  seenStableIdsInThisImport,
  conflictPolicy,
}) {
  if (deleteRequested)
    return { action: IMPORT_ACTION.REFUSED_DELETE, reason: "delete is disabled" };
  if (
    conflictPolicy !== IMPORT_CONFLICT_POLICY.SKIP &&
    conflictPolicy !== IMPORT_CONFLICT_POLICY.OVERWRITE
  ) {
    return {
      action: IMPORT_ACTION.REFUSED_UNKNOWN_CONFLICT_POLICY,
      reason: `unknown conflictPolicy: ${conflictPolicy}`,
    };
  }
  if (seenStableIdsInThisImport.has(stableId)) {
    return {
      action: IMPORT_ACTION.REFUSED_DUPLICATE_STABLE_ID_IN_IMPORT_SET,
      reason: "duplicate stable id in import batch",
    };
  }
  if (!existingStableIds.has(stableId)) return { action: IMPORT_ACTION.CREATE, reason: "OK" };
  if (conflictPolicy === IMPORT_CONFLICT_POLICY.OVERWRITE) {
    return { action: IMPORT_ACTION.OVERWRITE_EXISTING_STABLE_ID, reason: "OK" };
  }
  return { action: IMPORT_ACTION.SKIP_EXISTING_STABLE_ID, reason: "conflictPolicy is skip" };
}
