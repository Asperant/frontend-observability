import { describe, expect, it } from "vitest";

import {
  denormalizeForCreate,
  denormalizeForUpdate,
  extractDashboardBody,
  normalizeDashboardBody,
} from "../../../scripts/lab/dashboards/normalize.js";

const REAL_ENVELOPE = Object.freeze({
  v1: null,
  v2: null,
  v3: {
    version: 3,
    dashboardId: "7484879392171098112",
    title: "Frontend Operations",
    description: "desc [chicek:starter:frontend-operations:v1]",
    role: "",
    owner: "root@example.com",
    created: "2026-07-20T07:58:29.390Z",
    tabs: [{ tabId: "default", name: "Overview", panels: [] }],
    variables: { list: [] },
  },
  v4: null,
  v5: null,
  v6: null,
  v7: null,
  v8: null,
  version: 3,
  hash: "6321188812804760981",
  updatedAt: 0,
});

describe("extractDashboardBody", () => {
  it("extracts the v3 body from a real envelope", () => {
    expect(extractDashboardBody(REAL_ENVELOPE)).toBe(REAL_ENVELOPE.v3);
  });

  it("extracts the active version body from a newer OpenObserve envelope", () => {
    const envelope = {
      ...REAL_ENVELOPE,
      v3: null,
      v8: { ...REAL_ENVELOPE.v3, version: 8, title: "Session Investigation" },
      version: 8,
    };
    expect(extractDashboardBody(envelope)).toBe(envelope.v8);
  });

  it("falls back to the newest populated body when the envelope version is absent", () => {
    const envelope = {
      ...REAL_ENVELOPE,
      v3: null,
      v6: { ...REAL_ENVELOPE.v3, version: 6, title: "Fallback Body" },
      version: undefined,
    };
    expect(extractDashboardBody(envelope)).toBe(envelope.v6);
  });

  it("throws for an envelope with no populated body", () => {
    expect(() => extractDashboardBody({ version: 2, v3: null })).toThrow(/populated/);
  });

  it("throws for a null/undefined envelope", () => {
    expect(() => extractDashboardBody(null)).toThrow(/versioned dashboard envelope/);
  });
});

describe("normalizeDashboardBody", () => {
  it("strips server-only fields and keeps the portable shape", () => {
    const normalized = normalizeDashboardBody(REAL_ENVELOPE.v3);
    expect(normalized).toEqual({
      schemaVersion: 1,
      version: 3,
      title: "Frontend Operations",
      description: "desc [chicek:starter:frontend-operations:v1]",
      role: "",
      tabs: [{ tabId: "default", name: "Overview", panels: [] }],
      variables: { list: [] },
    });
    expect(normalized).not.toHaveProperty("dashboardId");
    expect(normalized).not.toHaveProperty("owner");
    expect(normalized).not.toHaveProperty("created");
  });

  it("defaults a missing role/tabs/variables", () => {
    const normalized = normalizeDashboardBody({ version: 3, title: "T", description: "" });
    expect(normalized.role).toBe("");
    expect(normalized.tabs).toEqual([]);
    expect(normalized.variables).toEqual({ list: [] });
  });
});

describe("denormalizeForCreate", () => {
  it("builds a create body with a fresh owner/created and an empty dashboardId", () => {
    const normalized = normalizeDashboardBody(REAL_ENVELOPE.v3);
    const body = denormalizeForCreate(normalized, {
      owner: "admin@example.com",
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    expect(body).toEqual({
      version: 3,
      dashboardId: "",
      title: "Frontend Operations",
      description: "desc [chicek:starter:frontend-operations:v1]",
      role: "",
      owner: "admin@example.com",
      created: "2026-07-20T00:00:00.000Z",
      tabs: normalized.tabs,
      variables: normalized.variables,
    });
  });

  it("defaults role to an empty string when the normalized shape omits it", () => {
    const body = denormalizeForCreate(
      { version: 3, title: "T", description: "", tabs: [], variables: { list: [] } },
      { owner: "a@b.com", createdAt: "now" },
    );
    expect(body.role).toBe("");
  });
});

describe("denormalizeForUpdate", () => {
  it("preserves the existing dashboard's identity fields", () => {
    const normalized = normalizeDashboardBody(REAL_ENVELOPE.v3);
    const body = denormalizeForUpdate(normalized, REAL_ENVELOPE.v3);
    expect(body.dashboardId).toBe(REAL_ENVELOPE.v3.dashboardId);
    expect(body.owner).toBe(REAL_ENVELOPE.v3.owner);
    expect(body.created).toBe(REAL_ENVELOPE.v3.created);
    expect(body.title).toBe(normalized.title);
  });

  it("defaults role to an empty string when the normalized shape omits it", () => {
    const body = denormalizeForUpdate(
      { version: 3, title: "T", description: "", tabs: [], variables: { list: [] } },
      REAL_ENVELOPE.v3,
    );
    expect(body.role).toBe("");
  });
});
