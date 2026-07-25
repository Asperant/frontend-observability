import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("delivery architecture contract", () => {
  it("keeps the browser package at exactly six public exports", () => {
    const source = readFileSync(
      join(repoRoot, "packages/browser-observability/src/index.js"),
      "utf8",
    );
    const exports = [...source.matchAll(/^export const ([a-zA-Z0-9_]+)/gm)].map(
      (match) => match[1],
    );
    expect(exports.sort()).toEqual(
      [
        "getObservabilityStatus",
        "initializeObservability",
        "recordAction",
        "recordError",
        "setTrackingConsent",
        "shutdownObservability",
      ].sort(),
    );
  });

  it("does not add a browser persistent queue or direct/fallback delivery module", () => {
    const source = readFileSync(
      join(repoRoot, "packages/browser-observability/dist/index.js"),
      "utf8",
    );
    expect(source).not.toMatch(/localStorage\.setItem|sessionStorage\.setItem|indexedDB/i);
    expect(source).not.toMatch(/directDelivery|fallbackDelivery|persistentQueue/i);
  });

  it("documents durable delivery as server-side only", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain(
      "Browser -> ingress/reverse proxy -> Telemetry Ingest -> RabbitMQ -> Telemetry Delivery Worker -> OpenObserve",
    );
    expect(readme).toMatch(/queue-backed delivery path/i);
  });
});
