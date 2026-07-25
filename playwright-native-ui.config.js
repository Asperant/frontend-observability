import { defineConfig, devices } from "@playwright/test";

// Native OpenObserve web UI smoke (native OpenObserve UI, Section 3.2):
// tests/e2e/native-ui-lab.spec.js. Split out of playwright-lab.config.js
// deliberately — its real-scheduler alert-evaluation probe
// (scripts/lab/alerts/real-evaluation-probe.mjs) takes minutes per run, so
// it belongs only in the manual release-acceptance workflow
// (.github/workflows/release-acceptance.yml), not every standard PR's
// `pnpm test:e2e:lab`. Same TLS-ignoring exception as playwright-lab.config.js
// applies here for the same reason (local lab CA, no sudo).
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /native-ui-lab\.spec\.js/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 300_000,
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
