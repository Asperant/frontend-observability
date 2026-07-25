import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");

const expectedDocs = [
  "docs/architecture.md",
  "docs/integration-guide.md",
  "docs/operations-runbook.md",
  "docs/production-handoff.md",
  "docs/security-model.md",
].sort();

describe("product documentation contract", () => {
  it("keeps only the approved Markdown documentation set", () => {
    const docs = readdirSync(join(repoRoot, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`)
      .sort();
    expect(docs).toEqual(expectedDocs);
    expect(existsSync(join(repoRoot, "README.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "CHANGELOG.md"))).toBe(true);
  });

  it("documents the immutable browser API and endpoint contract", () => {
    const readme = readDoc("README.md");
    for (const api of [
      "initializeObservability",
      "setTrackingConsent",
      "recordAction",
      "recordError",
      "getObservabilityStatus",
      "shutdownObservability",
    ]) {
      expect(readme).toContain(api);
    }
    for (const endpoint of [
      "POST /rum/v1/default/rum",
      "POST /rum/v1/default/logs",
      "GET /observability/config.json",
      "GET /observability/control.json",
    ]) {
      expect(readme).toContain(endpoint);
    }
  });

  it("does not reintroduce stage planning docs or stale product claims", () => {
    const docsText = ["README.md", "CHANGELOG.md", ...expectedDocs].map(readDoc).join("\n");
    expect(docsText).not.toMatch(/allowedSelectors|allowedRoutes|errorSampleRate/);
    expect(docsText).not.toMatch(/direct delivery|fallback delivery/i);
    expect(docsText).not.toMatch(/Session Replay.*supported/i);
    expect(docsText).toMatch(/3650 second durable-outage soak evidence/i);
  });

  it("keeps UI capability manifest aligned with starter alert files", () => {
    const manifest = JSON.parse(readDoc("infrastructure/openobserve/ui-capabilities.json"));
    const alerts = readdirSync(join(repoRoot, "infrastructure/openobserve/alerts/alerts"))
      .filter((name) => name.endsWith(".alert.json"))
      .map((name) => name.replace(/\.alert\.json$/, ""))
      .sort();
    expect(alerts.filter((name) => !name.startsWith("delivery-"))).toEqual(
      [...manifest.starterAlerts.productIds].sort(),
    );
    expect(manifest.unsupported).toContain("Session Replay");
    expect(manifest.unsupported).toContain("Safari/WebKit acceptance");
  });
});
