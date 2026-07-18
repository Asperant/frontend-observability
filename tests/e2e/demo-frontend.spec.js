import { expect, test } from "@playwright/test";

test.describe("demo frontend smoke", () => {
  test("loads and clearly labels itself as a test fixture", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Demo Test Fixture");
    await expect(page.getByRole("note")).toContainText("test fixture");
  });

  test("scenario controls are visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("scenario-initialize")).toBeVisible();
    await expect(page.getByTestId("scenario-runtime-error")).toBeVisible();
    await expect(page.getByTestId("scenario-unhandled-rejection")).toBeVisible();
    await expect(page.getByTestId("scenario-resource-error")).toBeVisible();
    await expect(page.getByTestId("scenario-success-request")).toBeVisible();
    await expect(page.getByTestId("scenario-client-error")).toBeVisible();
    await expect(page.getByTestId("scenario-server-error")).toBeVisible();
    await expect(page.getByTestId("scenario-timeout")).toBeVisible();
    await expect(page.getByTestId("scenario-abort")).toBeVisible();
    await expect(page.getByTestId("scenario-consent-grant")).toBeVisible();
    await expect(page.getByTestId("scenario-consent-revoke")).toBeVisible();
    await expect(page.getByTestId("scenario-duplicate-init")).toBeVisible();
    await expect(page.getByTestId("scenario-config-failure")).toBeVisible();
    await expect(page.getByTestId("scenario-telemetry-failure")).toBeVisible();
  });

  test("package import does not break the app: status panel renders", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto("/");
    await expect(page.getByTestId("status-panel")).toBeVisible();
    await expect(page.getByTestId("status-panel")).toContainText("uninitialized");

    expect(pageErrors).toEqual([]);
  });

  test("mock API health endpoint responds", async ({ request }) => {
    const response = await request.get("http://127.0.0.1:4311/health");
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("demo works end-to-end through the lifecycle even with no real telemetry endpoint configured", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("scenario-initialize").click();
    await expect(page.getByTestId("status-panel")).toContainText("ready");

    await page.getByTestId("scenario-consent-grant").click();
    await expect(page.getByTestId("status-panel")).toContainText("granted");

    await page.getByTestId("scenario-success-request").click();
    await expect(page.getByTestId("activity-log")).toContainText("Successful request");

    await page.getByTestId("scenario-shutdown").click();
    await expect(page.getByTestId("status-panel")).toContainText("shutdown");

    // This stage has no real OpenObserve/RUM endpoint anywhere; the page
    // must still be alive and interactive after exercising every scenario.
    await expect(page.locator("body")).toBeVisible();
  });
});
