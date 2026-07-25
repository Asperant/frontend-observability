// Shared login/navigation helpers for tests that drive OpenObserve's own
// native web UI directly (as opposed to the browser-app app it observes).
// Selectors here were reverse-engineered live against the pinned v0.91.2
// build (no public OpenObserve UI test-id documentation exists) — if the
// login form or nav structure changes in a future pinned version, these are
// the first things to re-check.
import { readFileSync } from "node:fs";

import { emailSecretPath, passwordSecretPath } from "../../../scripts/lab/common.mjs";

export const OPENOBSERVE_UI_BASE_URL = "http://localhost:5080";

export function readLabCredentials() {
  return {
    email: readFileSync(emailSecretPath, "utf8").trim(),
    password: readFileSync(passwordSecretPath, "utf8").trim(),
  };
}

export async function loginToOpenObserveUi(page) {
  const { email, password } = readLabCredentials();
  await page.goto(`${OPENOBSERVE_UI_BASE_URL}/web/login`, { waitUntil: "networkidle" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('[data-cy="login-sign-in"]').click();
  await page.waitForURL(/\/web\/?(\?|$)/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
}
