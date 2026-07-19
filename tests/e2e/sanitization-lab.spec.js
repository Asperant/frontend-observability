import { expect, test } from "@playwright/test";

const RAW_CANARIES = [
  "alice.test@example.invalid",
  "+1 415 555 0134",
  "GB82WEST12345698765432",
  "4111 1111 1111 1111",
  "Bearer abcdefghijklmnopqrstuvwxyz",
  "12345678901234567890",
  "?email=",
  "#token",
];

function isIngestionRequest(url) {
  const parsed = new URL(url);
  return parsed.pathname === "/rum/v1/default/rum" || parsed.pathname === "/rum/v1/default/logs";
}

test.describe("telemetry sanitization leakage guard", () => {
  test("does not send raw synthetic canaries in browser ingestion request bodies", async ({
    page,
  }) => {
    const bodies = [];
    page.on("request", (request) => {
      if (!isIngestionRequest(request.url())) return;
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await page.goto("/");
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.getByTestId("scenario-consent-grant").click();
    await page.getByTestId("scenario-safe-action").click();
    await page.getByTestId("scenario-pii-redacted-action").click();
    await page.getByTestId("scenario-pii-redacted-error").click();
    await page.getByTestId("scenario-secret-dropped-action").click();
    await page.getByTestId("scenario-secret-dropped-error").click();
    await page.getByTestId("scenario-url-normalization").click();
    await page.getByTestId("scenario-unsafe-attributes").click();
    await page.getByTestId("scenario-network-url-sanitization").click();
    await page.waitForTimeout(2500);

    expect(bodies.length).toBeGreaterThan(0);
    const allBodies = bodies.join("\n");
    for (const canary of RAW_CANARIES) {
      expect(allBodies).not.toContain(canary);
    }
    expect(allBodies).toContain("[REDACTED_EMAIL]");
    expect(allBodies).toContain("[REDACTED_ID]");
  });
});
