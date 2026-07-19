import { expect, test } from "@playwright/test";

test.describe("demo frontend smoke", () => {
  test("loads and clearly labels itself as a test fixture", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Demo Test Fixture");
    await expect(page.getByRole("note")).toContainText("test fixture");
  });

  test("Stage 7 lifecycle controls are visible", async ({ page }) => {
    await page.goto("/");
    for (const id of [
      "initialize",
      "initialize-runtime-config",
      "concurrent-init",
      "duplicate-init",
      "conflict-init",
      "consent-grant",
      "consent-revoke",
      "record-action",
      "record-error",
      "shutdown",
      "reinitialize",
      "invalid-config",
      "expired-config",
      "config-timeout",
      "disabled-config",
    ]) {
      await expect(page.getByTestId(`scenario-${id}`)).toBeVisible();
    }
  });

  test("package import does not break the app: status panel renders", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto("/");
    await expect(page.getByTestId("status-panel")).toBeVisible();
    await expect(page.getByTestId("status-panel")).toContainText("idle");
    await expect(page.getByTestId("status-panel")).toContainText("not-granted");

    expect(pageErrors).toEqual([]);
  });

  test("disabled config state is shown", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("scenario-disabled-config").click();
    await expect(page.getByTestId("status-panel")).toContainText("disabled");
    await expect(page.getByTestId("status-panel")).toContainText("CONFIG_DISABLED");
  });

  test("config timeout state is shown", async ({ page }) => {
    await page.route("**/observability/timeout.json", async () => {});
    await page.goto("/");
    await page.getByTestId("scenario-config-timeout").click();
    await expect(page.getByTestId("status-panel")).toContainText("CONFIG_TIMEOUT", {
      timeout: 5000,
    });
  });

  test("duplicate, conflict, consent, shutdown and reinitialize controls keep the host alive", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("scenario-concurrent-init").click();
    await expect(page.getByTestId("activity-log")).toContainText("Concurrent initialize");

    await page.getByTestId("scenario-conflict-init").click();
    await expect(page.getByTestId("activity-log")).toContainText("INITIALIZATION_CONFLICT");

    await page.getByTestId("scenario-consent-grant").click();
    await expect(page.getByTestId("status-panel")).toContainText("granted");

    await page.getByTestId("scenario-consent-revoke").click();
    await expect(page.getByTestId("status-panel")).toContainText("not-granted");

    await page.getByTestId("scenario-record-action").click();
    await expect(page.getByTestId("status-panel")).toContainText("droppedActions");

    await page.getByTestId("scenario-record-error").click();
    await expect(page.getByTestId("status-panel")).toContainText("droppedErrors");

    await page.getByTestId("scenario-shutdown").click();
    await expect(page.getByTestId("status-panel")).toContainText("shutdown");

    await page.getByTestId("scenario-reinitialize").click();
    await expect(page.getByTestId("status-panel")).toContainText("CONFIG_DISABLED");
    await expect(page.locator("body")).toBeVisible();
  });

  test("the real OpenObserve adapter initializes and does not break the demo", async ({ page }) => {
    // Stage 8: a real adapter is wired by default now, so this fixture
    // (schema-valid, enabled, but pointing at a non-resolving fake site)
    // reaches "active" instead of the pre-Stage-8 ADAPTER_UNAVAILABLE stub
    // gap — real ingestion requests to that fake site simply fail silently
    // (never surfacing as a page error), which is exactly the resilience
    // this test now demonstrates.
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto("/");
    await page.getByTestId("scenario-initialize").click();
    await expect(page.getByTestId("status-panel")).toContainText("active");
    await expect(page.getByTestId("status-panel")).toContainText("openobserve");
    await expect(page.locator("body")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("mock API health endpoint responds", async ({ request }) => {
    const response = await request.get("http://127.0.0.1:4311/health");
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
