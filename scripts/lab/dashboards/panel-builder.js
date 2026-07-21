// Pure translation from Stage 16's own starter-dashboard manifest shape
// (infrastructure/openobserve/analytics/dashboards/*.dashboard.json) plus
// the query catalog into a real OpenObserve v3 dashboard body
// (docs/openobserve-v0.91-dashboard-capabilities.md capability #10/#11). No
// I/O — the caller (scripts/lab/dashboards-install-starters.mjs) supplies
// the loaded query manifests and the variables to render with.

import { embedMarker } from "./marker.js";
import { renderQueryTemplate } from "./sql-template.js";

// A real customQuery panel's SQL is executed exactly as written regardless
// of this descriptor (verified live: a distinct-count column bound with
// functionName:"count" still displayed correctly) — but the OpenObserve
// v0.91.0 web UI will not render ANY chart type (stat/line/table alike)
// for a panel whose fields.y is empty, even though the query itself
// returns real, correct data. This was empirically reverse-engineered by
// creating an equivalent panel by hand in the real OpenObserve UI and
// reading back the exact shape it generated — see
// docs/openobserve-v0.91-dashboard-capabilities.md capability #11b. Every
// query's own expectedColumns therefore needs one of these per column so
// the frontend knows which result columns to bind/display; only `label`,
// `alias`, and `color` are ever meaningfully distinguishing per column.
const FIELD_COLORS = Object.freeze([
  "#5960b2",
  "#eb5757",
  "#f2994a",
  "#27ae60",
  "#2f80ed",
  "#9b51e0",
  "#219653",
  "#bb6bd9",
]);

function buildFieldDescriptor(column, index) {
  return {
    label: column.name,
    alias: column.name,
    color: FIELD_COLORS[index % FIELD_COLORS.length],
    type: "build",
    functionName: "count",
    args: [{ type: "field", value: { field: column.name } }],
    isDerived: false,
    havingConditions: [],
    treatAsNonTimestamp: true,
    showFieldAsJson: false,
  };
}

export function buildPanel(panelManifest, queryManifest, variables) {
  const sql = renderQueryTemplate(queryManifest, variables);
  const yFields = (queryManifest.expectedColumns ?? []).map((column, index) =>
    buildFieldDescriptor(column, index),
  );
  return {
    id: panelManifest.id,
    type: panelManifest.type,
    title: panelManifest.title,
    description: panelManifest.description ?? "",
    config: panelManifest.config ?? {},
    queryType: "sql",
    queries: [
      {
        query: sql,
        customQuery: true,
        fields: {
          stream: queryManifest.stream,
          stream_type: "logs",
          x: [],
          y: yFields,
          z: [],
          // A version-8 body (see buildStarterDashboardBody) requires this
          // exact object shape for a populated fields.y; an empty array
          // here 422s with "data did not match any variant of untagged enum
          // PanelFilter" (verified — capability #11b). The array shape
          // capability #11's note refers to is version-3-only.
          filter: { filterType: "group", logicalOperator: "AND", conditions: [] },
        },
        config: { promql_legend: "" },
      },
    ],
    layout: panelManifest.layout,
  };
}

export function buildTab(tabManifest, queryManifestsById, variables) {
  return {
    tabId: tabManifest.tabId,
    name: tabManifest.name,
    panels: tabManifest.panels.map((panelManifest) => {
      const queryManifest = queryManifestsById.get(panelManifest.queryRef);
      if (!queryManifest) {
        throw new Error(`buildTab: unknown queryRef '${panelManifest.queryRef}'`);
      }
      return buildPanel(panelManifest, queryManifest, variables);
    }),
  };
}

export function buildDashboardVariablesList(variableManifests) {
  return {
    list: (variableManifests ?? []).map((variable) => {
      if (variable.type === "constant") {
        return {
          name: variable.name,
          label: variable.label,
          type: "constant",
          value: variable.defaultValue ?? "",
          multiSelect: false,
        };
      }
      if (variable.type === "query_values") {
        return {
          name: variable.name,
          label: variable.label,
          type: "query_values",
          query_data: {
            stream: variable.stream,
            stream_type: "logs",
            field: variable.field,
            max_record_size: 10,
          },
          value: "",
          multiSelect: false,
        };
      }
      throw new Error(`buildDashboardVariablesList: unsupported variable type '${variable.type}'`);
    }),
  };
}

/**
 * Builds the full `tabs`/`variables` pair for one starter dashboard
 * manifest, given a Map of query id -> query manifest and the variables to
 * render every panel's SQL with (see
 * scripts/lab/dashboards/sql-template.js's DashboardVariableToken for the
 * session-investigation starter's exact-session panels).
 */
export function buildDashboardContent(dashboardManifest, queryManifestsById, variables) {
  return {
    tabs: dashboardManifest.tabs.map((tabManifest) =>
      buildTab(tabManifest, queryManifestsById, variables),
    ),
    variables: buildDashboardVariablesList(dashboardManifest.variables),
  };
}

/**
 * Builds a full, POST-ready create body for one starter dashboard manifest —
 * used identically by install-starters (only when creating) and
 * restore-starters (always, after any prior managed copy is deleted).
 */
export function buildStarterDashboardBody(
  dashboardManifest,
  queryManifestsById,
  variables,
  { owner, createdAt },
) {
  const { tabs, variables: variablesList } = buildDashboardContent(
    dashboardManifest,
    queryManifestsById,
    variables,
  );
  const description = embedMarker(
    dashboardManifest.description,
    dashboardManifest.starterId,
    dashboardManifest.starterVersion,
  );
  return {
    // Version 3 only tolerates empty fields.x/y/z arrays (capability #7);
    // a populated fields.y (needed for any panel to render at all, see
    // buildPanel's comment) requires a version-8 body or the create call
    // 422s with "invalid type: map, expected a string" — verified live,
    // capability #11b.
    version: 8,
    dashboardId: "",
    title: dashboardManifest.title,
    description,
    role: "",
    owner,
    created: createdAt,
    tabs,
    variables: variablesList,
  };
}
