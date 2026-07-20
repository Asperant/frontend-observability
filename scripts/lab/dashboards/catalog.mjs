// Loads the Stage 16 analytics catalog (metric catalog, query manifests,
// starter dashboards) from infrastructure/openobserve/analytics/. Pure I/O —
// no validation here (see query-manifest.js/metric-catalog.js for the pure,
// unit-coverage-gated validation logic), mirroring
// scripts/lab/streams/load-manifests.mjs's own split.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../common.mjs";

const ANALYTICS_DIR = join(repoRoot, "infrastructure/openobserve/analytics");
const QUERIES_DIR = join(ANALYTICS_DIR, "queries");
const DASHBOARDS_DIR = join(ANALYTICS_DIR, "dashboards");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadMetricCatalog() {
  return readJson(join(ANALYTICS_DIR, "metric-catalog.json"));
}

export function loadAllQueryManifests() {
  return readdirSync(QUERIES_DIR)
    .filter((name) => name.endsWith(".query.json"))
    .sort()
    .map((name) => readJson(join(QUERIES_DIR, name)));
}

export function loadAllStarterDashboards() {
  return readdirSync(DASHBOARDS_DIR)
    .filter((name) => name.endsWith(".dashboard.json"))
    .sort()
    .map((name) => readJson(join(DASHBOARDS_DIR, name)));
}
