import { describe, expect, it } from "vitest";

import {
  IMPORT_ACTION,
  IMPORT_CONFLICT_POLICY,
  INSTALL_ACTION,
  decideImportAction,
  decideInstallAction,
  decideRestoreAction,
  previouslyInstalledVersion,
} from "../../../scripts/lab/alerts/guard.js";
import { buildMarker, parseMarker } from "../../../scripts/lab/alerts/marker.js";

describe("alert starter guard", () => {
  it("parses and ignores malformed markers", () => {
    expect(parseMarker(buildMarker({ starterId: "a", starterVersion: 1 }))).toEqual({
      starterId: "a",
      starterVersion: 1,
    });
    expect(parseMarker("none")).toBeNull();
    expect(parseMarker("CHICEK_STAGE17_ALERT starterId=x")).toBeNull();
  });

  it("creates only missing never-installed starters", () => {
    expect(
      decideInstallAction({
        desiredStarterId: "a",
        desiredVersion: 1,
        desiredName: "A",
        existingAlerts: [],
      }).action,
    ).toBe(INSTALL_ACTION.CREATE);
  });

  it("does not overwrite installed, modified, deleted, or company alerts", () => {
    expect(
      decideInstallAction({
        desiredStarterId: "a",
        desiredVersion: 1,
        desiredName: "A",
        existingAlerts: [
          { name: "A", description: buildMarker({ starterId: "a", starterVersion: 1 }) },
        ],
      }).action,
    ).toBe(INSTALL_ACTION.NO_CHANGE_ALREADY_INSTALLED);
    expect(
      decideInstallAction({
        desiredStarterId: "a",
        desiredVersion: 2,
        desiredName: "A",
        existingAlerts: [
          { name: "A", description: buildMarker({ starterId: "a", starterVersion: 1 }) },
        ],
      }).action,
    ).toBe(INSTALL_ACTION.SKIP_INSTALLED_DIFFERENT_VERSION);
    expect(
      decideInstallAction({
        desiredStarterId: "a",
        desiredVersion: 1,
        desiredName: "A",
        existingAlerts: [],
        previouslyInstalledVersion: 1,
      }).action,
    ).toBe(INSTALL_ACTION.SKIP_PREVIOUSLY_DELETED_BY_COMPANY);
    expect(
      decideInstallAction({
        desiredStarterId: "a",
        desiredVersion: 1,
        desiredName: "A",
        existingAlerts: [{ name: "A", description: "company" }],
      }).action,
    ).toBe(INSTALL_ACTION.SKIP_NAME_COLLISION_UNMANAGED);
  });

  it("tracks install state and requires explicit restore confirmation", () => {
    expect(previouslyInstalledVersion({ installedStarters: { a: { version: 3 } } }, "a")).toBe(3);
    expect(previouslyInstalledVersion({}, "a")).toBeNull();
    expect(decideRestoreAction({ confirmed: false }).allowed).toBe(false);
    expect(decideRestoreAction({ confirmed: true }).allowed).toBe(true);
  });
});

describe("alert import guard", () => {
  it("is dry-run/non-destructive by default and checks collisions", () => {
    expect(
      decideImportAction({
        stableId: "a",
        existingStableIds: new Set(),
        seenStableIdsInThisImport: new Set(),
        conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
      }).action,
    ).toBe(IMPORT_ACTION.CREATE);
    expect(
      decideImportAction({
        stableId: "a",
        existingStableIds: new Set(["a"]),
        seenStableIdsInThisImport: new Set(),
        conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
      }).action,
    ).toBe(IMPORT_ACTION.SKIP_EXISTING_STABLE_ID);
    expect(
      decideImportAction({
        stableId: "a",
        existingStableIds: new Set(["a"]),
        seenStableIdsInThisImport: new Set(),
        conflictPolicy: IMPORT_CONFLICT_POLICY.OVERWRITE,
      }).action,
    ).toBe(IMPORT_ACTION.OVERWRITE_EXISTING_STABLE_ID);
    expect(
      decideImportAction({
        stableId: "a",
        existingStableIds: new Set(),
        seenStableIdsInThisImport: new Set(["a"]),
        conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
      }).action,
    ).toBe(IMPORT_ACTION.REFUSED_DUPLICATE_STABLE_ID_IN_IMPORT_SET);
    expect(
      decideImportAction({
        stableId: "a",
        deleteRequested: true,
        existingStableIds: new Set(),
        seenStableIdsInThisImport: new Set(),
        conflictPolicy: IMPORT_CONFLICT_POLICY.SKIP,
      }).action,
    ).toBe(IMPORT_ACTION.REFUSED_DELETE);
    expect(
      decideImportAction({
        stableId: "a",
        existingStableIds: new Set(),
        seenStableIdsInThisImport: new Set(),
        conflictPolicy: "bad",
      }).action,
    ).toBe(IMPORT_ACTION.REFUSED_UNKNOWN_CONFLICT_POLICY);
  });
});
