import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installDomGlobals, uninstallDomGlobals } from "./dom-globals.js";
import { PINNED_VERSIONS, packBrowserObservability } from "./pack-helpers.js";

let fixtureDir;

beforeAll(() => {
  const tarballPath = packBrowserObservability();

  fixtureDir = mkdtempSync(join(tmpdir(), "frontend-observability-consumer-vanilla-"));

  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "consumer-fixture-vanilla",
        version: "0.0.0",
        private: true,
        type: "module",
        devDependencies: { vite: PINNED_VERSIONS.vite },
        dependencies: { "@frontend-observability/browser-observability": `file:${tarballPath}` },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(fixtureDir, "vite.config.js"),
    `import { defineConfig } from "vite";

export default defineConfig({
  // The modulepreload polyfill is irrelevant here and touches browser-only
  // globals (MutationObserver) that a plain Node runtime smoke check lacks.
  build: { modulePreload: { polyfill: false } },
});
`,
  );

  writeFileSync(
    join(fixtureDir, "index.html"),
    `<!doctype html>
<html>
  <head><meta charset="UTF-8" /><title>Vanilla Consumer Smoke Fixture</title></head>
  <body>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
  );

  const srcDir = join(fixtureDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "main.js"),
    `import {
  getObservabilityStatus,
  initializeObservability,
  recordAction,
  setTrackingConsent,
  shutdownObservability,
} from "@frontend-observability/browser-observability";

globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
  schemaVersion: "1.0.0",
  configVersion: "consumer-disabled",
  enabled: false,
  issuedAt: "2026-07-19T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  killSwitch: { engaged: true },
  privacyProfile: "strict",
  sampling: { sessionSampleRate: 0},
  rum: {},
  browserLogs: { enabled: false },
  sessionReplay: { enabled: false },
  sensitiveRoutes: [],
}), { status: 200, headers: { "content-type": "application/json" } }));

const initResult = await initializeObservability({
  service: "consumer-smoke",
  environment: "production",
  version: "2026.07.1",
});
setTrackingConsent("granted");
const actionResult = recordAction("smoke.check", { source: "vanilla" });
const status = getObservabilityStatus();
const shutdownResult = await shutdownObservability();

globalThis.__SMOKE_RESULT__ = {
  ok: !initResult.ok && actionResult.reasonCode === "NOT_ACTIVE" && status.state === "disabled" && shutdownResult.ok,
  initResult,
  actionResult,
  status,
  shutdownResult,
};
`,
  );

  execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: fixtureDir,
    stdio: "inherit",
  });
  execFileSync("npx", ["vite", "build"], { cwd: fixtureDir, stdio: "inherit" });
}, 180_000);

afterAll(() => {
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe("vanilla JS consumer (packaged tarball, not workspace source)", () => {
  it("produces a production build", () => {
    const distFiles = readdirSync(join(fixtureDir, "dist"));
    expect(distFiles).toContain("index.html");
  });

  it("runtime smoke: the built bundle imports and exercises the public API without throwing", async () => {
    installDomGlobals("<!doctype html><html><body></body></html>");
    try {
      const assetsDir = join(fixtureDir, "dist", "assets");
      const jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
      expect(jsFiles.length).toBeGreaterThan(0);

      for (const file of jsFiles) {
        await import(pathToFileURL(join(assetsDir, file)).href);
      }

      expect(globalThis.__SMOKE_RESULT__?.ok).toBe(true);
    } finally {
      delete globalThis.__SMOKE_RESULT__;
      uninstallDomGlobals();
    }
  });
});
