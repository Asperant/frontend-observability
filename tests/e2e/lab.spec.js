import { expect, test } from "@playwright/test";

import { runDockerCompose } from "../../scripts/lab/common.mjs";
import { waitForHealthy } from "../../scripts/lab/wait.mjs";

test.describe("Stage 6 Docker reference lab (requires `pnpm lab:up` already running)", () => {
  test("https://localhost:8443 loads the demo test fixture", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Demo Test Fixture");
  });

  test("scenario controls are visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("scenario-initialize")).toBeVisible();
    await expect(page.getByTestId("scenario-success-request")).toBeVisible();
  });

  test("/mock/status/200 works through the reverse proxy", async ({ request }) => {
    const response = await request.get("/mock/status/200");
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ status: 200 });
  });

  test("OpenObserve management paths are rejected by the public reverse proxy", async ({
    request,
  }) => {
    const apiResponse = await request.get("/api/default/foo", { failOnStatusCode: false });
    expect(apiResponse.status()).toBe(403);

    const webResponse = await request.get("/web/", { failOnStatusCode: false });
    expect(webResponse.status()).toBe(404);

    const observabilityResponse = await request.get("/observability/unknown", {
      failOnStatusCode: false,
    });
    expect(observabilityResponse.status()).toBe(404);
  });

  test("the demo page still loads while OpenObserve is stopped", async ({ page }) => {
    test.setTimeout(120_000);
    runDockerCompose(["stop", "openobserve"]);
    try {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Demo Test Fixture");
    } finally {
      runDockerCompose(["start", "openobserve"]);
      const health = await waitForHealthy({ services: ["openobserve"], timeoutMs: 90_000 });
      expect(health.healthy).toBe(true);
    }
  });
});
