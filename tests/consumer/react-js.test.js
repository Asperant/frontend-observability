import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installDomGlobals, uninstallDomGlobals } from "./dom-globals.js";
import { PINNED_VERSIONS, packBrowserObservability } from "./pack-helpers.js";

let fixtureDir;

beforeAll(() => {
  const tarballPath = packBrowserObservability();

  fixtureDir = mkdtempSync(join(tmpdir(), "frontend-observability-consumer-react-"));

  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "consumer-fixture-react",
        version: "0.0.0",
        private: true,
        type: "module",
        devDependencies: {
          vite: PINNED_VERSIONS.vite,
          "@vitejs/plugin-react": PINNED_VERSIONS["@vitejs/plugin-react"],
        },
        dependencies: {
          "@frontend-observability/browser-observability": `file:${tarballPath}`,
          react: PINNED_VERSIONS.react,
          "react-dom": PINNED_VERSIONS["react-dom"],
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(fixtureDir, "vite.config.js"),
    `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The modulepreload polyfill is irrelevant here and touches browser-only
  // globals (MutationObserver) beyond what the JSDOM smoke shim provides.
  build: { modulePreload: { polyfill: false } },
});
`,
  );

  writeFileSync(
    join(fixtureDir, "index.html"),
    `<!doctype html>
<html>
  <head><meta charset="UTF-8" /><title>React Consumer Smoke Fixture</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  );

  const srcDir = join(fixtureDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "main.jsx"),
    `import { createRoot } from "react-dom/client";
import {
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
const actionResult = recordAction("smoke.check", { source: "react" });
const status = getObservabilityStatus();
const shutdownResult = await shutdownObservability();

const smokeResult = {
  ok: !initResult.ok && actionResult.reasonCode === "NOT_ACTIVE" && status.state === "disabled" && shutdownResult.ok,
};

globalThis.__SMOKE_RESULT__ = smokeResult;

function App() {
  return <div id="result">{JSON.stringify(smokeResult)}</div>;
}

createRoot(document.getElementById("app")).render(<App />);
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

describe("React + JS consumer (packaged tarball, not workspace source)", () => {
  it("produces a production build", () => {
    const distFiles = readdirSync(join(fixtureDir, "dist"));
    expect(distFiles).toContain("index.html");
  });

  it("runtime smoke: React can mount alongside the package with no conflicts", async () => {
    const distHtml = readFileSync(join(fixtureDir, "dist", "index.html"), "utf8");
    const dom = installDomGlobals(distHtml);

    try {
      const assetsDir = join(fixtureDir, "dist", "assets");
      const jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
      expect(jsFiles.length).toBeGreaterThan(0);

      for (const file of jsFiles) {
        await import(pathToFileURL(join(assetsDir, file)).href);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(globalThis.__SMOKE_RESULT__?.ok).toBe(true);
      expect(dom.window.document.getElementById("result")).not.toBeNull();
    } finally {
      delete globalThis.__SMOKE_RESULT__;
      uninstallDomGlobals();
    }
  });
});
