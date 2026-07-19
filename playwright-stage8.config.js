import { defineConfig, devices } from "@playwright/test";

// Stage 8 real OpenObserve RUM/browser-logs integration: talks to the
// already-running `pnpm lab:up` stack at https://localhost:8443, exactly
// like playwright-lab.config.js (same local-CA-not-installed exception).
//
// chromium and firefox both run this suite against the lab's self-signed
// HTTPS. webkit is deliberately excluded here: on this Linux toolchain,
// WebKit's ignoreHTTPSErrors path fails outright on the lab's self-signed
// certificate ("page.goto: WebKit encountered an internal error") even for
// a bare navigation with no application code involved — reproduced with a
// minimal script outside this test suite. This is the same category of
// constraint playwright-lab.config.js already documented (no sudo, so the
// local CA is never installed into the system trust store) — it already
// runs only chromium against the lab for this reason. webkit still gets
// full three-engine coverage of this adapter's actual behavior (consent
// gating, no session replay, dynamic-import failure isolation) via the
// plain-HTTP, non-lab suite in playwright.config.js, which every engine
// runs against a real — not mocked — @openobserve adapter.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /stage8-lab\.spec\.js/,
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
