import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const browserCoreRoot = join(
  repoRoot,
  "node_modules/.pnpm/@openobserve+browser-core@0.3.4/node_modules/@openobserve/browser-core",
);
const browserRumCoreRoot = join(
  repoRoot,
  "node_modules/.pnpm/@openobserve+browser-rum-core@0.3.4/node_modules/@openobserve/browser-rum-core",
);
const browserLogsRoot = join(
  repoRoot,
  "node_modules/.pnpm/@openobserve+browser-logs@0.3.4_@openobserve+browser-rum@0.3.4/node_modules/@openobserve/browser-logs",
);

describe("native delivery limitation (Stage 13, SECURITY BLOCKED)", () => {
  it("documents the installed OpenObserve SDK transport behavior from source", () => {
    const retry = read("browser-core", "esm/transport/sendWithRetryStrategy.js");
    const flush = read("browser-core", "esm/transport/flushController.js");
    const http = read("browser-core", "esm/transport/httpRequest.js");
    const batch = read("browser-core", "esm/transport/batch.js");
    const pageExit = read("browser-core", "esm/browser/pageMayExitObservable.js");
    const rumBatch = read("browser-rum-core", "esm/transport/startRumBatch.js");
    const logsBatch = read("browser-logs", "esm/transport/startLogsBatch.js");
    const behaviorDoc = readFileSync(
      join(repoRoot, "docs/openobserve-sdk-delivery-behavior.md"),
      "utf8",
    );
    const decisionDoc = readFileSync(
      join(repoRoot, "docs/telemetry-delivery-security-decision.md"),
      "utf8",
    );

    expect(flush).toContain("export const FLUSH_DURATION_LIMIT = (30 * ONE_SECOND)");
    expect(flush).toContain("export const MESSAGES_LIMIT = isWorkerEnvironment ? 1 : 50");
    expect(http).toContain("export const RECOMMENDED_REQUEST_BYTES_LIMIT = 16 * ONE_KIBI_BYTE");
    expect(batch).toContain("export const MESSAGE_BYTES_LIMIT = 256 * ONE_KIBI_BYTE");
    expect(rumBatch).toContain("createHttpRequest(endpoints, reportError)");
    expect(logsBatch).toContain("createHttpRequest(endpoints, reportError)");

    expect(retry).toContain("export const MAX_ONGOING_BYTES_COUNT = 80 * ONE_KIBI_BYTE");
    expect(retry).toContain("export const MAX_ONGOING_REQUESTS = 32");
    expect(retry).toContain("export const MAX_QUEUE_BYTES_COUNT = 20 * ONE_MEBI_BYTE");
    expect(retry).toContain("export const MAX_BACKOFF_TIME = ONE_MINUTE");
    expect(retry).toContain("response.status === 408");
    expect(retry).toContain("response.status === 429");
    expect(retry).toContain("isServerError(response.status)");
    expect(retry).not.toMatch(/Retry-After|retry-after/i);

    expect(pageExit).toContain("visibilitychange");
    expect(pageExit).toContain("freeze");
    expect(pageExit).toContain("beforeunload");
    expect(http).toContain("navigator.sendBeacon");
    expect(http).toContain("keepalive: true");

    expect(behaviorDoc).toContain("No maximum retry count or maximum retry age was found");
    expect(behaviorDoc).toContain("no native SDK circuit breaker is implemented");
    expect(decisionDoc).toContain("Security Blocked");
    expect(decisionDoc).toContain("no purge-on-revoke or purge-on-shutdown");
  });

  it("keeps the public browser package API at six functions", () => {
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

  it("does not patch global browser transports or add a persistent/manual delivery queue", () => {
    const files = listSourceFiles(join(repoRoot, "packages/browser-observability/src"));
    const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");

    expect(combined).not.toMatch(/(?:globalThis|window)\.fetch\s*=(?!=)/);
    expect(combined).not.toMatch(/XMLHttpRequest\.prototype\.[a-zA-Z]+\s*=(?!=)/);
    expect(combined).not.toMatch(/sendBeacon\s*=(?!=)/);
    expect(combined).not.toMatch(/localStorage\.setItem|sessionStorage\.setItem|indexedDB/i);

    const hasDeliveryOrSamplingModule = files.some(
      (file) =>
        file.includes(`${join("src", "delivery")}`) || file.includes(`${join("src", "sampling")}`),
    );
    expect(hasDeliveryOrSamplingModule).toBe(false);
  });

  it("does not claim a delivery/storage acknowledgement anywhere in status or diagnostics source", () => {
    const files = [
      ...listSourceFiles(join(repoRoot, "packages/browser-observability/src/status")),
      ...listSourceFiles(join(repoRoot, "packages/browser-observability/src/diagnostics")),
    ];
    const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(combined.toLowerCase()).not.toMatch(/\bdelivered\b|\bstored\b/);
  });
});

function read(pkg, path) {
  const roots = {
    "browser-core": browserCoreRoot,
    "browser-rum-core": browserRumCoreRoot,
    "browser-logs": browserLogsRoot,
  };
  return readFileSync(join(roots[pkg], path), "utf8");
}

function listSourceFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath);
    return fullPath.endsWith(".js") ? [fullPath] : [];
  });
}
