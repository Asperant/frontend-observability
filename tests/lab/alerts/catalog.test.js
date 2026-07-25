import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../../../scripts/lab/common.mjs";
import {
  loadAllAlertPolicies,
  loadAlertPolicyCatalog,
  loadAlertTemplates,
  loadDestinationReferences,
} from "../../../scripts/lab/alerts/catalog.mjs";
import { validateAlertPolicy } from "../../../scripts/lab/alerts/policy.js";
import {
  loadAllQueryManifests,
  loadMetricCatalog,
} from "../../../scripts/lab/dashboards/catalog.mjs";

describe("alert-governance alert catalog", () => {
  it("validates all starter policies against dashboard-governance catalogs", () => {
    const catalog = loadAlertPolicyCatalog();
    const policies = loadAllAlertPolicies();
    const metrics = new Set(loadMetricCatalog().metrics.map((metric) => metric.id));
    const queries = new Set(loadAllQueryManifests().map((query) => query.id));
    const destinations = new Set(
      loadDestinationReferences().destinationRefs.map((destination) => destination.id),
    );
    expect(catalog.starterPolicyIds.sort()).toEqual(policies.map((policy) => policy.id).sort());
    for (const policy of policies) {
      expect(
        validateAlertPolicy(policy, {
          knownMetricIds: metrics,
          knownQueryIds: queries,
          knownDestinationRefs: destinations,
        }),
      ).toEqual({ valid: true, errors: [] });
    }
  });

  it("keeps templates and manifests secret-safe", () => {
    const templates = loadAlertTemplates();
    expect(templates).toHaveLength(1);
    const combined = JSON.stringify({
      templates,
      destinations: loadDestinationReferences(),
      policies: loadAllAlertPolicies(),
    });
    expect(combined).not.toMatch(
      /cookie|authorization|password|secret|session_id|request_body|response_body|_sessionreplay/i,
    );
    expect(combined).not.toMatch(/https?:\/\/[^"]+/i);
  });

  it("keeps public browser API surface at six exports", () => {
    const source = readFileSync(
      join(repoRoot, "packages/browser-observability/src/index.js"),
      "utf8",
    );
    expect([...source.matchAll(/^export\s+const\s+/gm)]).toHaveLength(6);
  });
});
