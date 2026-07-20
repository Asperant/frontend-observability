// Pure translation from Stage 16's own starter-dashboard manifest shape
// (infrastructure/openobserve/analytics/dashboards/*.dashboard.json) plus
// the query catalog into a real OpenObserve v3 dashboard body
// (docs/openobserve-v0.91-dashboard-capabilities.md capability #10/#11). No
// I/O — the caller (scripts/lab/dashboards-install-starters.mjs) supplies
// the loaded query manifests and the variables to render with.

import { embedMarker } from "./marker.js";
import { renderQueryTemplate } from "./sql-template.js";

export function buildPanel(panelManifest, queryManifest, variables) {
  const sql = renderQueryTemplate(queryManifest, variables);
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
          y: [],
          z: [],
          filter: [],
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
          value: "",
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
    version: 3,
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
