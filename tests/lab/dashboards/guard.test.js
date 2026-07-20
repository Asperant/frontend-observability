import { describe, expect, it } from "vitest";

import {
  decideImportAction,
  decideInstallAction,
  decideRestoreAction,
  IMPORT_ACTION,
  IMPORT_CONFLICT_POLICY,
  INSTALL_ACTION,
  previouslyInstalledVersion,
} from "../../../scripts/lab/dashboards/guard.js";
import { buildMarker } from "../../../scripts/lab/dashboards/marker.js";

describe("decideInstallAction", () => {
  it("recommends CREATE when nothing matches", () => {
    const result = decideInstallAction({
      desiredStarterId: "frontend-operations",
      desiredVersion: 1,
      desiredTitle: "Frontend Operations",
      existingDashboards: [],
    });
    expect(result).toEqual({ action: INSTALL_ACTION.CREATE, reason: "OK" });
  });

  it("recommends NO_CHANGE_ALREADY_INSTALLED when the marker version matches", () => {
    const result = decideInstallAction({
      desiredStarterId: "frontend-operations",
      desiredVersion: 1,
      desiredTitle: "Frontend Operations",
      existingDashboards: [
        { title: "Frontend Operations", description: buildMarker("frontend-operations", 1) },
      ],
    });
    expect(result.action).toBe(INSTALL_ACTION.NO_CHANGE_ALREADY_INSTALLED);
  });

  it("recommends SKIP_INSTALLED_DIFFERENT_VERSION when the marker version differs", () => {
    const result = decideInstallAction({
      desiredStarterId: "frontend-operations",
      desiredVersion: 2,
      desiredTitle: "Frontend Operations",
      existingDashboards: [
        { title: "Frontend Operations", description: buildMarker("frontend-operations", 1) },
      ],
    });
    expect(result.action).toBe(INSTALL_ACTION.SKIP_INSTALLED_DIFFERENT_VERSION);
  });

  it("recommends SKIP_PREVIOUSLY_DELETED_BY_COMPANY when local state says it was installed but is now absent", () => {
    const result = decideInstallAction({
      desiredStarterId: "frontend-operations",
      desiredVersion: 1,
      desiredTitle: "Frontend Operations",
      existingDashboards: [],
      previouslyInstalledVersion: 1,
    });
    expect(result.action).toBe(INSTALL_ACTION.SKIP_PREVIOUSLY_DELETED_BY_COMPANY);
  });

  it("recommends SKIP_TITLE_COLLISION_UNMANAGED for an unmarked title collision", () => {
    const result = decideInstallAction({
      desiredStarterId: "frontend-operations",
      desiredVersion: 1,
      desiredTitle: "Frontend Operations",
      existingDashboards: [
        { title: "Frontend Operations", description: "created by hand, no marker" },
      ],
    });
    expect(result.action).toBe(INSTALL_ACTION.SKIP_TITLE_COLLISION_UNMANAGED);
  });

  it("ignores a marker belonging to a different starterId", () => {
    const result = decideInstallAction({
      desiredStarterId: "frontend-operations",
      desiredVersion: 1,
      desiredTitle: "Frontend Operations",
      existingDashboards: [
        { title: "Error Analysis", description: buildMarker("error-analysis", 1) },
      ],
    });
    expect(result.action).toBe(INSTALL_ACTION.CREATE);
  });
});

describe("previouslyInstalledVersion", () => {
  it("returns the recorded version", () => {
    const state = { installedStarters: { "frontend-operations": { version: 1 } } };
    expect(previouslyInstalledVersion(state, "frontend-operations")).toBe(1);
  });

  it("returns null when the starter has no record", () => {
    expect(previouslyInstalledVersion({ installedStarters: {} }, "frontend-operations")).toBeNull();
  });

  it("returns null when installState itself is missing/malformed", () => {
    expect(previouslyInstalledVersion(null, "frontend-operations")).toBeNull();
    expect(previouslyInstalledVersion({}, "frontend-operations")).toBeNull();
  });
});

describe("decideRestoreAction", () => {
  it("refuses without confirmation", () => {
    expect(decideRestoreAction({ confirmed: false })).toEqual({
      allowed: false,
      reason: "CONFIRMATION_REQUIRED",
    });
    expect(decideRestoreAction({ confirmed: undefined })).toEqual({
      allowed: false,
      reason: "CONFIRMATION_REQUIRED",
    });
  });

  it("allows with explicit confirmation", () => {
    expect(decideRestoreAction({ confirmed: true })).toEqual({ allowed: true, reason: "OK" });
  });
});

describe("decideImportAction", () => {
  it("refuses an unknown conflict policy", () => {
    const result = decideImportAction({
      title: "X",
      existingDashboards: [],
      conflictPolicy: "bogus",
      seenTitlesInThisImport: new Set(),
    });
    expect(result.action).toBe(IMPORT_ACTION.REFUSED_UNKNOWN_CONFLICT_POLICY);
  });

  it("refuses a duplicate title within the same import batch", () => {
    const result = decideImportAction({
      title: "X",
      existingDashboards: [],
      conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
      seenTitlesInThisImport: new Set(["X"]),
    });
    expect(result.action).toBe(IMPORT_ACTION.REFUSED_DUPLICATE_TITLE_IN_IMPORT_SET);
  });

  it("recommends CREATE for a new title", () => {
    const result = decideImportAction({
      title: "X",
      existingDashboards: [],
      conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
      seenTitlesInThisImport: new Set(),
    });
    expect(result).toEqual({ action: IMPORT_ACTION.CREATE, reason: "OK" });
  });

  it("recommends SKIP_EXISTING_TITLE under the default skip policy", () => {
    const result = decideImportAction({
      title: "X",
      existingDashboards: [{ title: "X", dashboardId: "1" }],
      conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
      seenTitlesInThisImport: new Set(),
    });
    expect(result.action).toBe(IMPORT_ACTION.SKIP_EXISTING_TITLE);
  });

  it("recommends OVERWRITE_EXISTING_TITLE under the overwrite policy", () => {
    const result = decideImportAction({
      title: "X",
      existingDashboards: [{ title: "X", dashboardId: "1" }],
      conflictPolicy: IMPORT_CONFLICT_POLICY.OVERWRITE,
      seenTitlesInThisImport: new Set(),
    });
    expect(result).toEqual({
      action: IMPORT_ACTION.OVERWRITE_EXISTING_TITLE,
      reason: "OK",
      existingDashboardId: "1",
    });
  });
});
