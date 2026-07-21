import { describe, expect, it } from "vitest";

import { loadAllStarterDashboards } from "../../../scripts/lab/dashboards/catalog.mjs";

const OPENOBSERVE_GRID_COLUMNS = 48;
const FIREFOX_SAFE_PANEL_TYPES = new Set(["stat", "table", "line", "bar", "gauge", "metric"]);

describe("starter dashboard manifests", () => {
  it("uses OpenObserve's 48-column dashboard grid", () => {
    const dashboards = loadAllStarterDashboards();
    for (const dashboard of dashboards) {
      for (const tab of dashboard.tabs ?? []) {
        for (const panel of tab.panels ?? []) {
          const layout = panel.layout;
          expect(layout, `${dashboard.starterId}/${panel.id}`).toBeDefined();
          expect(layout.x, `${dashboard.starterId}/${panel.id} x`).toBeGreaterThanOrEqual(0);
          expect(layout.w, `${dashboard.starterId}/${panel.id} w`).toBeGreaterThan(0);
          expect(layout.x + layout.w, `${dashboard.starterId}/${panel.id} x+w`).toBeLessThanOrEqual(
            OPENOBSERVE_GRID_COLUMNS,
          );
        }
      }
    }
  });

  it("keeps full-row table panels wide enough for Firefox dashboard rendering", () => {
    const dashboards = loadAllStarterDashboards();
    const tablePanels = dashboards.flatMap((dashboard) =>
      (dashboard.tabs ?? []).flatMap((tab) =>
        (tab.panels ?? [])
          .filter((panel) => panel.type === "table")
          .map((panel) => ({ dashboard, panel })),
      ),
    );
    expect(tablePanels.length).toBeGreaterThan(0);
    for (const { dashboard, panel } of tablePanels) {
      expect(panel.layout.w, `${dashboard.starterId}/${panel.id}`).toBeGreaterThanOrEqual(24);
    }
  });

  it("stacks every same-tab panel vertically without overlap", () => {
    // Multiple panels per tab were live-verified (Chromium and Firefox) to
    // render correctly once capability #11b's fields.y/version/filter fix
    // landed — the earlier one-panel-per-tab split was working around that
    // same underlying blank-panel bug, not a real multi-panel limitation.
    const dashboards = loadAllStarterDashboards();
    for (const dashboard of dashboards) {
      for (const tab of dashboard.tabs ?? []) {
        const sorted = [...tab.panels].sort((a, b) => a.layout.y - b.layout.y);
        let expectedY = 0;
        for (const panel of sorted) {
          expect(panel.layout.y, `${dashboard.starterId}/${panel.id} y`).toBe(expectedY);
          expectedY += panel.layout.h;
        }
      }
    }
  });

  it("uses panel types that are supported by the pinned OpenObserve UI", () => {
    const dashboards = loadAllStarterDashboards();
    for (const dashboard of dashboards) {
      for (const tab of dashboard.tabs ?? []) {
        for (const panel of tab.panels ?? []) {
          expect(
            FIREFOX_SAFE_PANEL_TYPES.has(panel.type),
            `${dashboard.starterId}/${panel.id} type=${panel.type}`,
          ).toBe(true);
        }
      }
    }
  });
});
