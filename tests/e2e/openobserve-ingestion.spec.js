import { expect, test } from "@playwright/test";

import { runDockerCompose } from "../../scripts/lab/common.mjs";
import { waitForHealthy } from "../../scripts/lab/wait.mjs";

// OpenObserve integration real OpenObserve RUM/browser-logs integration, requires
// `pnpm lab:up` already running (same stack as tests/e2e/lab.spec.js).
// These tests exercise the *real* @openobserve/browser-rum +
// @openobserve/browser-logs SDKs through the real reverse-proxy ingestion
// allowlist — no mocked network layer.

function isIngestRequest(request) {
  const url = new URL(request.url());
  return url.pathname === "/rum/v1/default/rum" || url.pathname === "/rum/v1/default/logs";
}

test.describe("OpenObserve integration OpenObserve RUM/browser-logs integration", () => {
  test("sends no telemetry before consent is granted", async ({ page }) => {
    const ingestRequests = [];
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestRequests.push(request.url());
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await expect(page.getByTestId("status-panel")).toContainText("active");
    await page.getByTestId("scenario-record-action").click();
    await page.getByTestId("scenario-record-error").click();
    await page.waitForTimeout(1000);

    expect(ingestRequests).toEqual([]);
  });

  test("sends real RUM/action/error/log/network telemetry after consent is granted", async ({
    page,
  }) => {
    const ingestRequests = [];
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestRequests.push(request.url());
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.getByTestId("scenario-record-error").click();
    await page.getByTestId("scenario-success-request").click();
    await page.waitForTimeout(300);
    // The RUM/logs SDK batches and only auto-flushes every 30s (or on a
    // page-exit signal: visibilitychange/pagehide/freeze) — a real,
    // deliberate batching behavior, not a bug. A reload triggers that
    // page-exit flush immediately instead of waiting out the real interval;
    // the flush request can fire mid-navigation, so wait for it and the
    // reload concurrently rather than one after the other.
    await Promise.all([
      page.waitForRequest((request) => isIngestRequest(request), { timeout: 10_000 }),
      page.reload(),
    ]);

    expect(ingestRequests.length).toBeGreaterThan(0);
    expect(ingestRequests.some((url) => url.includes("/rum/v1/default/rum"))).toBe(true);
    // Every real ingest request goes through the allowlisted org/api-version
    // only, with no browser-facing query string — never a wildcard org,
    // and never straight to openobserve's own management surface.
    for (const url of ingestRequests) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://localhost:8443");
      expect(parsed.pathname).toMatch(/^\/rum\/v1\/default\/(rum|logs)$/);
      expect(parsed.search).toBe("");
    }
  });

  test("stops sending new telemetry after consent is revoked", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(800);

    await page.getByTestId("scenario-consent-revoke").click();

    const ingestRequestsAfterRevoke = [];
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestRequestsAfterRevoke.push(request.url());
    });
    await page.getByTestId("scenario-record-action").click();
    await page.getByTestId("scenario-record-error").click();
    await expect(page.getByTestId("status-panel")).toContainText("droppedActions");
    await page.waitForTimeout(1000);

    expect(ingestRequestsAfterRevoke).toEqual([]);
  });

  test("never records or requests session replay", async ({ page }) => {
    const replayRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("/replay")) replayRequests.push(request.url());
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.getByTestId("scenario-long-task").click();
    await page.waitForTimeout(1000);

    expect(replayRequests).toEqual([]);
  });

  test("a single action does not cause an unbounded request chain (no recursion)", async ({
    page,
  }) => {
    let ingestCount = 0;
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestCount += 1;
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    const countAfterInit = ingestCount;

    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(2000);

    // One user action must produce a small, bounded number of ingest
    // requests (the RUM SDK batches), never a runaway/self-triggering chain.
    expect(ingestCount - countAfterInit).toBeLessThan(10);
  });

  test("shutdown stops telemetry and a real reinitialize resumes it with a new session", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(500);

    await page.getByTestId("scenario-shutdown").click();
    await expect(page.getByTestId("status-panel")).toContainText("shutdown");

    const ingestRequestsAfterShutdown = [];
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestRequestsAfterShutdown.push(request.url());
    });
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(500);
    expect(ingestRequestsAfterShutdown).toEqual([]);

    await page.getByTestId("scenario-initialize-runtime-config").click();
    await expect(page.getByTestId("status-panel")).toContainText("active");

    const ingestRequestsAfterReinit = [];
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestRequestsAfterReinit.push(request.url());
    });
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(300);
    // Force the SDK's page-exit flush hook (see the "sends real ... after
    // consent is granted" test above for why this is needed).
    await Promise.all([
      page.waitForRequest((request) => isIngestRequest(request), { timeout: 10_000 }),
      page.reload(),
    ]);

    expect(ingestRequestsAfterReinit.length).toBeGreaterThan(0);
  });

  test("failure isolation: a wrong RUM token still keeps the demo usable", async ({ page }) => {
    await page.route("**/rum/v1/default/*", (route) => route.fulfill({ status: 403, body: "" }));

    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.getByTestId("scenario-record-error").click();
    await page.waitForTimeout(500);

    await expect(page.locator("body")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("failure isolation: a 503 from the ingestion proxy does not break the demo", async ({
    page,
  }) => {
    await page.route("**/rum/v1/default/*", (route) => route.fulfill({ status: 503, body: "" }));

    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(500);

    await expect(page.locator("body")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("failure isolation: OpenObserve being fully down does not break the demo", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    runDockerCompose(["stop", "openobserve"]);
    try {
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error));

      await page.goto("/");
      await page.getByTestId("scenario-initialize-runtime-config").click();
      await page.getByTestId("scenario-consent-grant").click();
      await page.getByTestId("scenario-record-action").click();
      await page.waitForTimeout(500);

      await expect(page.locator("body")).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      runDockerCompose(["start", "openobserve"]);
      const health = await waitForHealthy({ services: ["openobserve"], timeoutMs: 90_000 });
      expect(health.healthy).toBe(true);
    }
  });

  test("SDK import/init failure (dynamic import blocked) does not break the demo", async ({
    page,
  }) => {
    // The browser-app's own production build re-hashes this chunk's
    // filename (e.g. "adapter-openobserve-XXXXXXXX.js"), so the pattern
    // must not assume the exact unhashed name used inside the
    // @chicek/browser-observability package's own build output, or a
    // trailing ".js" (a query string may follow it).
    await page.route("**/adapter-openobserve*", (route) => route.abort("failed"));

    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await expect(page.getByTestId("status-panel")).toContainText("ADAPTER_INITIALIZATION_FAILED");
    await page.getByTestId("scenario-record-action").click();

    await expect(page.locator("body")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
