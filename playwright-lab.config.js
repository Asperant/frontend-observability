import { defineConfig, devices } from "@playwright/test";

// Stage 6 Docker reference lab: this config talks to the already-running
// `pnpm lab:up` stack at https://localhost:8443, never starts its own
// dev server, and — because the local lab CA is intentionally never
// installed into the system trust store (no sudo, per Stage 6 rules) —
// is the ONLY Playwright config in this repo allowed to ignore TLS
// certificate errors. That exception must never be copied into the
// production-facing playwright.config.js.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /lab\.spec\.js/,
  // native-ui-lab.spec.js has its own dedicated config
  // (playwright-native-ui.config.js): it drives OpenObserve's own web UI
  // and its real-scheduler alert-evaluation probe takes minutes per run —
  // heavy enough that it belongs only in the manual release-acceptance
  // workflow, not every standard PR's `pnpm test:e2e:lab`.
  testIgnore: /native-ui-lab\.spec\.js/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "https://localhost:8443",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
