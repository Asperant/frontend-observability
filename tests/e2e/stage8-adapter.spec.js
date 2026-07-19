import { expect, test } from "@playwright/test";

// Stage 8 real-adapter behavior, run across all three engines
// (chromium/firefox/webkit) against the plain, non-Docker demo server
// (see playwright.config.js). This exercises the real
// @openobserve/browser-rum + @openobserve/browser-logs SDKs — the
// "scenario-initialize" fixture (valid-enabled.json) is schema-valid and
// enabled, just pointed at 127.0.0.1:59999 (a real, resolvable address
// nothing listens on), so requests genuinely leave the SDK's transport
// layer and simply get refused — the "OpenObserve unreachable" resilience
// case. Positive, real end-to-end ingestion against a live, reachable
// OpenObserve — including a real shutdown -> reinitialize -> second-event
// cycle confirmed via genuine network traffic — is covered by
// tests/e2e/stage8-lab.spec.js (chromium + firefox: see
// playwright-stage8.config.js for why webkit is excluded there); this file
// intentionally does not duplicate those positive assertions against a
// connection that never succeeds, since observing the exact moment a
// refused-connection request fires around a forced page-exit flush proved
// unreliable across engines in this environment and added no coverage
// beyond what the lab suite already proves rigorously.

function isIngestRequest(request) {
  const url = new URL(request.url());
  return url.pathname.startsWith("/rum/") || url.pathname.startsWith("/v1/");
}

test.describe("Stage 8 real adapter behavior (all engines)", () => {
  test("sends no telemetry before consent is granted", async ({ page }) => {
    const ingestRequests = [];
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestRequests.push(request.url());
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize").click();
    await expect(page.getByTestId("status-panel")).toContainText("active");
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(800);

    expect(ingestRequests).toEqual([]);
  });

  test("never requests session replay", async ({ page }) => {
    const replayRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.includes("replay")) replayRequests.push(request.url());
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.getByTestId("scenario-long-task").click();
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForTimeout(500);

    expect(replayRequests).toEqual([]);
  });

  test("a single action does not cause an unbounded request chain", async ({ page }) => {
    let ingestCount = 0;
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestCount += 1;
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForTimeout(1000);

    expect(ingestCount).toBeLessThan(10);
  });

  test("shutdown stops telemetry and a real reinitialize resumes the adapter", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("scenario-initialize").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-shutdown").click();
    await expect(page.getByTestId("status-panel")).toContainText("shutdown");

    const ingestRequestsAfterShutdown = [];
    page.on("request", (request) => {
      if (isIngestRequest(request)) ingestRequestsAfterShutdown.push(request.url());
    });
    await page.getByTestId("scenario-record-action").click();
    await page.waitForTimeout(500);
    expect(ingestRequestsAfterShutdown).toEqual([]);

    // Real reinitialize against the same (real, not a stub) adapter — not
    // the "reinitialize" button, which intentionally targets a disabled
    // fixture for an unrelated Stage 7 test. Genuine post-reinit ingestion
    // traffic is confirmed by tests/e2e/stage8-lab.spec.js against a real,
    // reachable OpenObserve (see the file-level comment above).
    await page.getByTestId("scenario-initialize").click();
    await expect(page.getByTestId("status-panel")).toContainText("active");
    await expect(page.getByTestId("status-panel")).toContainText("openobserve");
  });

  test("SDK import/init failure (dynamic import blocked) does not break the demo", async ({
    page,
  }) => {
    // No trailing ".js" requirement: Vite's dev server appends a
    // cache-busting "?t=..." query string after the real filename.
    await page.route("**/adapter-openobserve*", (route) => route.abort("failed"));

    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto("/");
    await page.getByTestId("scenario-initialize").click();
    await expect(page.getByTestId("status-panel")).toContainText("ADAPTER_INITIALIZATION_FAILED");

    await expect(page.locator("body")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
