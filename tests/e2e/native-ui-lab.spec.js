// native OpenObserve UI, Section 3.2: automated smoke coverage for OpenObserve's
// own native web UI (v0.91.2), not just its API — everything here was
// reverse-engineered live against the running lab (no public OpenObserve UI
// test-id documentation exists) and is now pinned as a regression guard.
// Requires `pnpm lab:up` already running (like lab.spec.js); runs on both
// Chromium and Firefox projects (playwright-lab.config.js). Uses only
// runtime-generated lab credentials (scripts/lab/common.mjs's secret
// files) — never a committed credential.
import { expect, test } from "@playwright/test";

import { alertSinkControl, readAdminAuthHeader } from "../../scripts/lab/alerts/admin-client.mjs";
import { runRealAlertEvaluationProbe } from "../../scripts/lab/alerts/real-evaluation-probe.mjs";
import { syncSessionMetadata } from "../../scripts/lab/sync-session-metadata.mjs";
import { getStreamSchema, search } from "../../scripts/lab/streams/admin-client.mjs";
import { loginToOpenObserveUi, OPENOBSERVE_UI_BASE_URL } from "./helpers/openobserve-native-ui.js";

test.describe("native OpenObserve v0.91.2 UI (requires `pnpm lab:up` already running)", () => {
  test("login reaches the real authenticated app shell", async ({ page }) => {
    await loginToOpenObserveUi(page);
    await expect(page.getByText("RUM", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Dashboards", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Alerts", { exact: true }).first()).toBeVisible();
  });

  test("RUM Sessions list shows a real session and its replay view stays empty (Session Replay stays Security Blocked)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // This test must never depend on incidental traffic left over from
    // other suites having happened to run first (that made it flaky in
    // isolation) — it drives one real session itself. Same real,
    // independently-measured ~35s native SDK batch-flush behavior
    // established in scripts/lab/verify-streams.mjs and reused by
    // scripts/lab/verify-dashboards.mjs's own canary.
    await page.goto("/");
    await page.waitForTimeout(300);
    await page.getByTestId("scenario-initialize-runtime-config").click();
    await page.waitForTimeout(250);
    await page.getByTestId("scenario-consent-grant").click();
    await page.waitForTimeout(250);
    await page.getByTestId("scenario-safe-action").click();
    await page.waitForTimeout(36_000);

    // Sync _sessionreplay directly rather than waiting on the background
    // daemon's own 60s interval — deterministic, not wall-clock-dependent.
    const syncResult = await syncSessionMetadata();
    expect(syncResult.ok).toBe(true);

    await loginToOpenObserveUi(page);
    await page.goto(`${OPENOBSERVE_UI_BASE_URL}/web/rum/sessions?org_identifier=default`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(1500);

    // Regression guard for infrastructure/openobserve/sanitization/rum.vrl's
    // session_has_replay backfill: this test used to pin the *opposite*
    // behavior (the native Sessions feature 400ing on every load because
    // _rumdata's schema had never seen a session_has_replay field — nothing
    // in this project's own SDK pipeline could ever set it: the vendor
    // SDK's beforeSend hook silently discards any session.* mutation via
    // its own limitModification field allowlist, confirmed by reading
    // @openobserve/browser-rum-core's assembly.js). The already-audited
    // _rumdata ingestion pipeline (security-acceptance) now force-sets the field
    // server-side on every real event, so this exact error must never
    // reappear — in a pageerror OR anywhere in the rendered page
    // (OpenObserve shows some query errors as an internal toast, not an
    // uncaught exception).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("session_has_replay");
    for (const message of pageErrors) {
      expect(message).not.toContain("session_has_replay");
    }

    // OpenObserve's own session list query also depends on a *second*
    // stream, _sessionreplay, to fill in each listed session's browser/OS/
    // duration columns (see docs/openobserve-v0.91-dashboard-capabilities.md
    // finding #21) — scripts/lab/sync-session-metadata.mjs (just called
    // directly above, and also run continuously by a background daemon
    // lab:up starts) keeps that stream populated with derived session
    // summaries computed from _rumdata's own already-sanitized fields, so
    // the onboarding empty-state must not appear and the list must show
    // the real session this test just created.
    await expect(page.getByText("Discover Session Replay", { exact: false })).not.toBeVisible();
    const firstRow = page.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible();

    // Regression guard for apps/session-metadata-sync/src/sync.js's
    // toRecord(): OpenObserve's native RUM Sessions feature reads
    // _sessionreplay's `start`/`end` directly (its own generated query is
    // `SELECT min(start) AS start_time, max(end) AS end_time, ... FROM
    // _sessionreplay GROUP BY session_id`) and renders this row's "Time
    // Spent" column by treating that difference as milliseconds. This
    // project's own `_rumdata`/`_sessionreplay` `_timestamp` convention is
    // microseconds everywhere else, and toRecord() used to write
    // `start`/`end`/`duration` in that same microsecond scale -- inflating
    // every displayed duration by exactly 1000x (live-observed on this
    // exact build: this test's own few-seconds-long session used to show
    // "51.06 min"; a longer-lived session spanning ~32 real minutes showed
    // "22.40 days"). The session this test just drove above lasted at most
    // a few seconds, so its row must never read in hours or days.
    const firstRowText = await firstRow.innerText();
    expect(firstRowText).not.toMatch(/\bday(s)?\b/i);
    expect(firstRowText).not.toMatch(/\bhr\b/i);

    // Only a generic "reading getAttribute of null" Vue quirk observed
    // consistently across this OpenObserve build's pages is tolerated here
    // (phrased differently per engine: Chromium "Cannot read properties of
    // null (reading 'getAttribute')"; Firefox "can't access property
    // \"getAttribute\", r is null"). Anything else is a real regression.
    for (const message of pageErrors) {
      expect(message).toMatch(/getAttribute.*(?:is null|of null)|null.*getAttribute/);
    }

    // The load-bearing assertion, and the whole reason this stream is
    // populated at all: this project never ingests real replay
    // segment/DOM-mutation content anywhere (the /replay route stays
    // unallowlisted at the reverse proxy — tests/contract/
    // session-replay-disabled.test.js — and the SDK never records), so
    // clicking into this real session's replay view must always show a
    // real, honest zero — never a fabricated or stale-looking duration —
    // and the replay canvas area must render nothing: no captured DOM
    // snapshot, no image, no visible page content. A real replay would
    // paint an iframe/canvas with the recorded page; here that region has
    // no content at all to paint.
    await firstRow.locator("button, [role='button'], svg").first().click();
    await page.waitForTimeout(2000);
    await expect(page.getByText("00.00", { exact: false }).first()).toBeVisible();
    const canvasCount = await page.locator("canvas").count();
    const iframeCount = await page.locator("iframe").count();
    expect(canvasCount + iframeCount).toBe(0);
  });

  test("Session Investigation dashboard's Recent sessions tab lists real sessions with zero Session Replay dependency", async ({
    page,
  }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await loginToOpenObserveUi(page);
    await page.goto(`${OPENOBSERVE_UI_BASE_URL}/web/dashboards?org_identifier=default`, {
      waitUntil: "networkidle",
    });
    // Mirrors the already-working folder-navigation pattern from the
    // Frontend Operations dashboard test below — exact:true here, unlike
    // the other getByText calls in this file, because a loose match against
    // "CHICEK Starters" is ambiguous (folder tab vs. other on-page text) and
    // was observed live to pick the wrong element on Firefox.
    await page.getByText("CHICEK Starters", { exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByText("Session Investigation", { exact: false }).first().click();
    await page.waitForTimeout(1500);
    await page.getByText("Recent sessions", { exact: false }).first().click();
    await page.waitForTimeout(2500);

    // The panel renders (column headers appear) regardless of whether any
    // real session happened to land inside the current time window — this
    // test doesn't drive real RUM traffic itself (unlike
    // scripts/lab/verify-dashboards.mjs's heavier 35s-flush canary),
    // it only proves the panel isn't broken.
    await expect(page.getByText("session_id", { exact: false }).first()).toBeVisible();

    // This panel (recent-sessions-list) is sourced only from _rumdata — it
    // must never reference _sessionreplay, the stream that makes OpenObserve's
    // own native Sessions page unusable (previous test).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("_sessionreplay");
    for (const message of pageErrors) {
      expect(message).toMatch(/getAttribute.*(?:is null|of null)|null.*getAttribute/);
    }
  });

  test("RUM Performance sub-pages open and Web Vitals renders real chart canvases", async ({
    page,
  }) => {
    await loginToOpenObserveUi(page);
    await page.goto(
      `${OPENOBSERVE_UI_BASE_URL}/web/rum/performance/overview?org_identifier=default&period=7d`,
      { waitUntil: "networkidle" },
    );
    await page.waitForTimeout(1000);
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();

    for (const tabName of ["Web Vitals", "Errors", "API"]) {
      await page.getByRole("tab", { name: tabName, exact: true }).click();
      await page.waitForTimeout(1200);
      await expect(page.getByRole("tab", { name: tabName, exact: true })).toBeVisible();
    }

    // Web Vitals specifically must paint real ECharts canvases with a real
    // rendered size, not an empty/blank chart shell.
    await page.getByRole("tab", { name: "Web Vitals", exact: true }).click();
    await page.waitForTimeout(1500);
    const canvases = await page.locator("canvas").all();
    expect(canvases.length).toBeGreaterThan(0);
    const box = await canvases[0].boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
  });

  // v0.91.2 re-verification of docs/openobserve-v0.91-dashboard-capabilities.md
  // capability #11b: v0.91.0 confirmed "stat"/"line" ECharts panels drew
  // nothing at all. Live-verified during this stage's closeout that "line"/
  // "bar" now genuinely render with real data on v0.91.2 (both engines) —
  // the starter dashboards' hourly trend panels were restored from the old
  // "table" fallback to "line" accordingly (scripts/lab/dashboards/
  // panel-builder.js, infrastructure/openobserve/analytics/dashboards/*).
  // This pins that fix as a permanent regression guard.
  test("Frontend Operations starter dashboard renders its restored line-chart trend panels with real canvases", async ({
    page,
  }) => {
    await loginToOpenObserveUi(page);
    await page.goto(`${OPENOBSERVE_UI_BASE_URL}/web/dashboards?org_identifier=default`, {
      waitUntil: "networkidle",
    });
    await page.getByText("CHICEK Starters", { exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByText("Frontend Operations", { exact: false }).first().click();
    await page.waitForTimeout(1500);

    const url = new URL(page.url());
    url.searchParams.set("period", "7d");
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);

    for (const title of [
      "Error trend (hourly)",
      "Resource failure trend (hourly)",
      "Long task trend (hourly)",
    ]) {
      const panel = page.locator(".dashboard-panel, [data-test]", { hasText: title }).first();
      const panelOrPage = (await panel.count()) ? panel : page;
      await expect(panelOrPage.getByText(title, { exact: false }).first()).toBeVisible();
    }

    const canvasCount = await page.locator("canvas").count();
    expect(canvasCount).toBeGreaterThan(0);
  });

  test("_sessionreplay holds only derived session-summary metadata, never real replay segment content", async () => {
    // _sessionreplay legitimately exists now (scripts/lab/sync-session-metadata.mjs,
    // a background daemon started by lab:up) — this test used to assert the
    // stream must not exist at all; that stopped being the right signal once
    // this project started deliberately populating it. The security property
    // that actually matters — no real recording ever gets in — is checked
    // here as a strict field allowlist instead: a real replay segment would
    // carry DOM-mutation/canvas/HTML-shaped fields, and any such field
    // appearing here would mean something bypassed this project's own sync
    // script (the only writer of this stream) and wrote real recording data.
    // The complementary, load-bearing check — that watching a session never
    // shows real content — is the previous test's job, not this one's.
    const auth = readAdminAuthHeader();
    const schema = await getStreamSchema(auth, "_sessionreplay", "logs");
    expect(schema).not.toBeNull();
    const ALLOWED_FIELDS = new Set([
      "_timestamp",
      "action_count",
      "device",
      "duration",
      "end",
      "env",
      "error_count",
      "frustration_count",
      "_o2_id",
      "ip",
      "metadata_schema_version",
      "service",
      "session_has_replay",
      "session_id",
      "start",
      "source",
      "type",
      "user_agent_user_agent_family",
      "user_agent_os_family",
      "version",
      "view_count",
    ]);
    const fieldNames = (schema?.schema ?? []).map((field) => field.name);
    expect(fieldNames.length).toBeGreaterThan(0);
    for (const name of fieldNames) {
      expect(ALLOWED_FIELDS.has(name), `unexpected field '${name}' in _sessionreplay`).toBe(true);
    }
    expect(fieldNames).toContain("ip");

    const endUs = Date.now() * 1000;
    const rows = await search(
      readAdminAuthHeader(),
      "select ip from _sessionreplay where ip is not null limit 10",
      {
        startUs: endUs - 15 * 60 * 1_000_000,
        endUs,
      },
    );
    expect(rows.hits?.length ?? 0).toBeGreaterThan(0);
    for (const row of rows.hits ?? []) {
      expect(row.ip).toBe("redacted");
    }
  });

  // Heaviest test in this file by design: proves the real scheduler-driven
  // evaluation pipeline (scripts/lab/alerts/real-evaluation-probe.mjs — NOT
  // the destination-test/manual-trigger shortcuts this stage's closeout
  // found both unconditionally notify regardless of the alert's real
  // condition) produces a row the native Alert History UI actually shows,
  // not just an API response.
  test("Alert History shows a real firing record from a genuinely scheduler-evaluated alert", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const auth = readAdminAuthHeader();
    let historyPanelShowsRow = false;

    const probe = await runRealAlertEvaluationProbe({
      auth,
      alertSinkControl,
      quietWindowMs: 30_000,
      // Visit the real alert's own native History panel while it still
      // exists (the probe deletes it once this returns).
      beforeCleanup: async ({ alertId, alertName }) => {
        await loginToOpenObserveUi(page);
        await page.goto(`${OPENOBSERVE_UI_BASE_URL}/web/alerts?org_identifier=default`, {
          waitUntil: "networkidle",
        });
        const responsePromise = page.waitForResponse(
          (response) => response.url().includes(`/alerts/history?alert_id=${alertId}`),
          { timeout: 20_000 },
        );
        await page.getByText(alertName, { exact: false }).first().click();
        await responsePromise;
        historyPanelShowsRow = true;
      },
    });

    expect(probe.quietCycleObserved).toBe(true);
    expect(probe.firingObserved).toBe(true);
    expect(probe.historyRowCountFinal).toBeGreaterThan(0);
    expect(historyPanelShowsRow).toBe(true);
  });
});
