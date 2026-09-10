import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Must match CONTROL_ENDPOINT_PATH in
// packages/browser-observability/src/runtime-control/constants.js.
const CONTROL_ENDPOINT_PATH = "/observability/control.json";

/**
 * The runtime-control runtime-control document is deliberately short-lived
 * (issuedAt close to "now", TTL <= 10 minutes) so it can never be a static
 * fixture file the way /observability/config.json is. In the Docker lab
 * this same exact path is served by the reverse proxy from an
 * operator-generated, atomically-rewritten file (see
 * scripts/lab/generate-runtime-control.mjs); here, for the plain `vite`
 * dev server this repo's non-lab Playwright suite runs against
 * (playwright.config.js), a small dev-only middleware computes an
 * equivalently fresh, schema-valid, always-inactive document on every
 * request instead.
 */
function runtimeControlDevMiddleware() {
  return {
    name: "frontend-observability-runtime-control-dev-fixture",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== CONTROL_ENDPOINT_PATH || !["GET", "HEAD"].includes(req.method)) {
          next();
          return;
        }
        const now = new Date();
        const body = JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
          killSwitch: { active: false, reasonCode: "none" },
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.end(req.method === "HEAD" ? undefined : body);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), runtimeControlDevMiddleware()],
});
