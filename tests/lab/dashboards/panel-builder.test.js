import { describe, expect, it } from "vitest";

import {
  buildDashboardContent,
  buildDashboardVariablesList,
  buildPanel,
  buildStarterDashboardBody,
  buildTab,
} from "../../../scripts/lab/dashboards/panel-builder.js";

const QUERY_MANIFEST = Object.freeze({
  id: "sessions-count",
  stream: "_rumdata",
  sqlTemplate:
    "select count(*) as sessions from _rumdata where service = {{service}} and env = {{environment}}",
  requiredVariables: ["service", "environment"],
  optionalVariables: [],
  drilldownVariables: [],
});

const PANEL_MANIFEST = Object.freeze({
  id: "sessions",
  type: "metric",
  title: "Sessions",
  description: "",
  config: { show_legends: false },
  queryRef: "sessions-count",
  layout: { x: 0, y: 0, w: 4, h: 6, i: 1 },
});

describe("buildPanel", () => {
  it("builds a real OpenObserve panel body from a panel manifest + query manifest", () => {
    const panel = buildPanel(PANEL_MANIFEST, QUERY_MANIFEST, {
      service: "demo-frontend",
      environment: "lab",
    });
    expect(panel).toEqual({
      id: "sessions",
      type: "metric",
      title: "Sessions",
      description: "",
      config: { show_legends: false },
      queryType: "sql",
      queries: [
        {
          query:
            "select count(*) as sessions from _rumdata where service = 'demo-frontend' and env = 'lab'",
          customQuery: true,
          fields: {
            stream: "_rumdata",
            stream_type: "logs",
            x: [],
            y: [],
            z: [],
            filter: { filterType: "group", logicalOperator: "AND", conditions: [] },
          },
          config: { promql_legend: "" },
        },
      ],
      layout: PANEL_MANIFEST.layout,
    });
  });

  it("defaults description/config when the panel manifest omits them", () => {
    const { description: _description, config: _config, ...rest } = PANEL_MANIFEST;
    const panel = buildPanel(rest, QUERY_MANIFEST, {
      service: "demo-frontend",
      environment: "lab",
    });
    expect(panel.description).toBe("");
    expect(panel.config).toEqual({});
  });

  it("builds a y field descriptor per expectedColumns entry so the OpenObserve UI can bind/render the result (capability #11b)", () => {
    const queryManifestWithColumns = {
      ...QUERY_MANIFEST,
      expectedColumns: [
        { name: "sessions", type: "Int64" },
        { name: "sessions_with_error", type: "Int64" },
      ],
    };
    const panel = buildPanel(PANEL_MANIFEST, queryManifestWithColumns, {
      service: "demo-frontend",
      environment: "lab",
    });
    expect(panel.queries[0].fields.y).toEqual([
      {
        label: "sessions",
        alias: "sessions",
        color: "#5960b2",
        type: "build",
        functionName: "count",
        args: [{ type: "field", value: { field: "sessions" } }],
        isDerived: false,
        havingConditions: [],
        treatAsNonTimestamp: true,
        showFieldAsJson: false,
      },
      {
        label: "sessions_with_error",
        alias: "sessions_with_error",
        color: "#eb5757",
        type: "build",
        functionName: "count",
        args: [{ type: "field", value: { field: "sessions_with_error" } }],
        isDerived: false,
        havingConditions: [],
        treatAsNonTimestamp: true,
        showFieldAsJson: false,
      },
    ]);
  });
});

describe("buildTab", () => {
  it("builds every panel in the tab, resolving queryRef against the map", () => {
    const tab = buildTab(
      { tabId: "default", name: "Overview", panels: [PANEL_MANIFEST] },
      new Map([["sessions-count", QUERY_MANIFEST]]),
      { service: "demo-frontend", environment: "lab" },
    );
    expect(tab.tabId).toBe("default");
    expect(tab.panels).toHaveLength(1);
  });

  it("throws for an unknown queryRef", () => {
    expect(() =>
      buildTab({ tabId: "default", name: "Overview", panels: [PANEL_MANIFEST] }, new Map(), {}),
    ).toThrow(/unknown queryRef/);
  });
});

describe("buildDashboardVariablesList", () => {
  it("builds a constant variable", () => {
    const list = buildDashboardVariablesList([
      { name: "session_id", label: "Session ID", type: "constant" },
    ]);
    expect(list).toEqual({
      list: [
        {
          name: "session_id",
          label: "Session ID",
          type: "constant",
          value: "",
          multiSelect: false,
        },
      ],
    });
  });

  it("uses a constant variable default value when provided", () => {
    const list = buildDashboardVariablesList([
      {
        name: "session_id",
        label: "Session ID",
        type: "constant",
        defaultValue: "paste-session-id",
      },
    ]);
    expect(list.list[0].value).toBe("paste-session-id");
  });

  it("builds a query_values variable", () => {
    const list = buildDashboardVariablesList([
      {
        name: "service",
        label: "Service",
        type: "query_values",
        field: "service",
        stream: "_rumdata",
      },
    ]);
    expect(list).toEqual({
      list: [
        {
          name: "service",
          label: "Service",
          type: "query_values",
          query_data: {
            stream: "_rumdata",
            stream_type: "logs",
            field: "service",
            max_record_size: 10,
          },
          value: "",
          multiSelect: false,
        },
      ],
    });
  });

  it("defaults to an empty list when variableManifests is omitted", () => {
    expect(buildDashboardVariablesList()).toEqual({ list: [] });
  });

  it("throws for an unsupported variable type", () => {
    expect(() => buildDashboardVariablesList([{ name: "x", label: "X", type: "bogus" }])).toThrow(
      /unsupported variable type/,
    );
  });
});

describe("buildDashboardContent", () => {
  it("builds tabs and variables together", () => {
    const content = buildDashboardContent(
      {
        tabs: [{ tabId: "default", name: "Overview", panels: [PANEL_MANIFEST] }],
        variables: [
          {
            name: "service",
            label: "Service",
            type: "query_values",
            field: "service",
            stream: "_rumdata",
          },
        ],
      },
      new Map([["sessions-count", QUERY_MANIFEST]]),
      { service: "demo-frontend", environment: "lab" },
    );
    expect(content.tabs).toHaveLength(1);
    expect(content.variables.list).toHaveLength(1);
  });
});

describe("buildStarterDashboardBody", () => {
  it("builds a full create body with an embedded marker", () => {
    const body = buildStarterDashboardBody(
      {
        starterId: "frontend-operations",
        starterVersion: 1,
        title: "Frontend Operations",
        description: "Overview dashboard.",
        tabs: [{ tabId: "default", name: "Overview", panels: [PANEL_MANIFEST] }],
        variables: [],
      },
      new Map([["sessions-count", QUERY_MANIFEST]]),
      { service: "demo-frontend", environment: "lab" },
      { owner: "admin@example.com", createdAt: "2026-07-20T00:00:00.000Z" },
    );
    expect(body.version).toBe(8);
    expect(body.dashboardId).toBe("");
    expect(body.title).toBe("Frontend Operations");
    expect(body.description).toBe("Overview dashboard. [chicek:starter:frontend-operations:v1]");
    expect(body.owner).toBe("admin@example.com");
    expect(body.created).toBe("2026-07-20T00:00:00.000Z");
    expect(body.tabs).toHaveLength(1);
  });
});
