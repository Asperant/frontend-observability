import { defineConfig, devices } from "@playwright/test";

const DEMO_PORT = 4173;
const MOCK_API_PORT = 4311;

export default defineConfig({
  testDir: "tests/e2e",
  // Docker-lab specs target https://localhost:8443 and run only under their
  // dedicated configs after `pnpm lab:up`; the default suite stays fixture-only.
  testIgnore: /(lab|native-ui-lab|openobserve-ingestion)\.spec\.js/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${DEMO_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      command: `node tests/fixtures/apps/http-test-service/src/server.js`,
      url: `http://127.0.0.1:${MOCK_API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(MOCK_API_PORT) },
      timeout: 30_000,
    },
    {
      command: `pnpm --filter @chicek/browser-app-fixture exec vite --port ${DEMO_PORT} --strictPort`,
      url: `http://127.0.0.1:${DEMO_PORT}`,
      reuseExistingServer: !process.env.CI,
      env: { VITE_MOCK_API_BASE_URL: `http://127.0.0.1:${MOCK_API_PORT}` },
      timeout: 60_000,
    },
  ],
});
