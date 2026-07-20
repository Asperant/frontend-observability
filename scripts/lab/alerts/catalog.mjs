import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../common.mjs";

const ALERTS_DIR = join(repoRoot, "infrastructure/openobserve/alerts");
const POLICIES_DIR = join(ALERTS_DIR, "alerts");
const TEMPLATES_DIR = join(ALERTS_DIR, "templates");
const DESTINATIONS_DIR = join(ALERTS_DIR, "destinations");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadAlertPolicyCatalog() {
  return readJson(join(ALERTS_DIR, "alert-policy-catalog.json"));
}

export function loadAllAlertPolicies() {
  return readdirSync(POLICIES_DIR)
    .filter((file) => file.endsWith(".alert.json"))
    .sort()
    .map((file) => readJson(join(POLICIES_DIR, file)));
}

export function loadAlertTemplates() {
  return readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith(".template.json"))
    .sort()
    .map((file) => readJson(join(TEMPLATES_DIR, file)));
}

export function loadDestinationReferences() {
  return readJson(join(DESTINATIONS_DIR, "destination-references.json"));
}
