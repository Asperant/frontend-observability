// `pnpm test:streams` — stream-lifecycle acceptance gate. Static test
// alone is not enough (roadmap requirement), so this script combines:
//   1. a coverage-checked vitest run of scripts/lab/streams/'s pure logic
//      (100% statements/branches/functions/lines, scoped — see
//      vitest.config.js's "scripts/lab/streams/**" threshold entry);
//   2. canonical stream existence/settings/pipeline read-back and drift
//      (scripts/lab/streams-verify.mjs's own logic, reused directly);
//   3. dry-run/provision idempotency (runs provision twice in-process);
//   4. the canonical-stream destructive guard (an attempted delete of
//      _rumdata/_rumlog must be refused before any HTTP call is made);
//   5. a full disposable-stream lifecycle
//      (create/canary-ingest/settings-apply/idempotent-reapply/delete/
//      cleanup-verify) on a uniquely-named _chicek_lifecycle_test_* stream;
//   6. management-plane isolation (the browser-facing :8443 proxy must
//      still refuse every admin/stream/schema endpoint);
//   7. a real Chromium + Firefox schema canary driven through the actual
//      demo app and real @openobserve SDKs, validated against the
//      schema contracts, with replay-absence and correlation correlation
//      checks.
// Never prints a raw secret, credential, or full ingested record.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { chromium, firefox } from "@playwright/test";

import {
  assertExactLabToolchain,
  caCertPath,
  emailSecretPath,
  log,
  logError,
  passwordSecretPath,
} from "./common.mjs";
import { streamsProvision } from "./streams-provision.mjs";
import { streamsVerify } from "./streams-verify.mjs";
import {
  CANONICAL_STREAMS,
  GUARD_REASON,
  generateDisposableStreamName,
  isNonDestructiveSettingsChange,
  validateDestructiveTarget,
} from "./streams/guard.js";
import {
  ORG_ID,
  deleteStream,
  getStreamSchema,
  ingestJson,
  readAdminAuthHeader,
  search,
  updateStreamSettings,
} from "./streams/admin-client.mjs";
import { DRIFT_CLASS, classifyDrift } from "./streams/drift.js";
import { loadStreamDefinition } from "./streams/load-manifests.mjs";
import { isNoChange, normalizeServerSettings, diffSettings } from "./streams/manifest.js";
import { isRecordClean, validateRecord } from "./streams/schema-contract.js";
import { DEMO_IDENTITY } from "../../tests/fixtures/apps/browser-app/src/identity.js";
import { RUM_APPLICATION_ID } from "./generate-runtime-config.mjs";

const DEMO_URL = "https://localhost:8443";
const NOW_US = () => Date.now() * 1000;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

function readAdminSecretValues() {
  return [
    readFileSync(emailSecretPath, "utf8").trim(),
    readFileSync(passwordSecretPath, "utf8").trim(),
  ];
}

function assertNoSecretLeak(findings, secretValues) {
  const haystack = JSON.stringify(findings);
  for (const secret of secretValues) {
    if (secret && haystack.includes(secret)) {
      throw new Error(
        "INTERNAL: a stream-lifecycle finding string contained a raw admin credential.",
      );
    }
  }
}

// --- 1. coverage-checked unit suite for scripts/lab/streams/ -------------

function runStreamsUnitCoverage() {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "lab",
      "tests/lab/streams",
      "--coverage",
      "--coverage.include=scripts/lab/streams/**/*.js",
    ],
    { encoding: "utf8" },
  );
  return {
    pass: result.status === 0,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-4000),
  };
}

// --- 4. canonical destructive guard ---------------------------------------

async function ensureCanonicalStreamsExist(auth) {
  const now = Date.now();
  const rumSessionId = `stream-seed-session-${crypto.randomUUID()}`;
  const rumViewId = `stream-seed-view-${crypto.randomUUID()}`;
  const seeds = [
    {
      stream: "_rumdata",
      records: [
        {
          _timestamp: now * 1000,
          date: now,
          type: "view",
          application_id: RUM_APPLICATION_ID,
          service: DEMO_IDENTITY.service,
          env: DEMO_IDENTITY.environment,
          version: DEMO_IDENTITY.version,
          session_id: rumSessionId,
          source: "stream-seed",
          sdk_version: "stream-seed",
          view_id: rumViewId,
          view_url: "https://localhost:8443/stream-seed",
          view_cumulative_layout_shift: 0.01,
          session_has_replay: false,
        },
      ],
    },
    {
      stream: "_rumlog",
      records: [
        {
          _timestamp: now * 1000,
          date: now,
          message: "stream seed log",
          status: "info",
          origin: "logger",
          application_id: RUM_APPLICATION_ID,
          service: DEMO_IDENTITY.service,
          env: DEMO_IDENTITY.environment,
          version: DEMO_IDENTITY.version,
          sdk_version: "stream-seed",
        },
      ],
    },
  ];

  for (const seed of seeds) {
    if (await getStreamSchema(auth, seed.stream)) continue;
    const result = await ingestJson(auth, seed.stream, seed.records);
    if (!result.ok) throw new Error(`seed for ${seed.stream} failed (${result.status})`);
    await waitUntil(async () => Boolean(await getStreamSchema(auth, seed.stream)));
  }
}

async function verifyCanonicalDestructiveGuardBlocked(auth) {
  const findings = [];
  for (const streamName of CANONICAL_STREAMS) {
    const verdict = validateDestructiveTarget({ org: ORG_ID, streamName, confirmed: true });
    if (verdict.allowed || verdict.reason !== GUARD_REASON.CANONICAL_STREAM_BLOCKED) {
      findings.push(`Destructive guard did not hard-block canonical stream ${streamName}.`);
      continue;
    }
    // Defense in depth: prove the canonical stream is genuinely untouched
    // by re-reading it, rather than trusting the pure guard alone.
    const schema = await getStreamSchema(auth, streamName);
    if (!schema) {
      findings.push(`Canonical stream ${streamName} unexpectedly missing after guard check.`);
    }
  }
  return findings;
}

// --- 5. disposable stream lifecycle ---------------------------------------

async function verifyDisposableLifecycle(auth, testRunId) {
  const findings = [];
  const streamName = generateDisposableStreamName(`gate_${testRunId}`);

  const target = validateDestructiveTarget({ org: ORG_ID, streamName, confirmed: true });
  if (!target.allowed) {
    findings.push(`Disposable stream name ${streamName} was unexpectedly refused by the guard.`);
    return findings;
  }

  // create + safe canary ingest (no secret/PII shape, deliberately inert)
  const ingest = await ingestJson(auth, streamName, [
    { message: "stream-lifecycle-disposable-canary", level: "info", run: testRunId },
  ]);
  if (!ingest.ok) {
    findings.push(
      `Disposable stream ${streamName} canary ingest failed (status ${ingest.status}).`,
    );
    return findings;
  }
  await waitUntil(async () => Boolean(await getStreamSchema(auth, streamName)));

  // schema/settings read-back
  const created = await getStreamSchema(auth, streamName);
  if (!created || created.schema.length === 0) {
    findings.push(`Disposable stream ${streamName} schema read-back is empty after ingest.`);
  }

  // supported setting apply (data_retention) + idempotent second apply
  const patch = { data_retention: 7 };
  if (!isNonDestructiveSettingsChange("data_retention", 7)) {
    findings.push("INTERNAL: data_retention:7 unexpectedly failed the non-destructive guard.");
  }
  const firstApply = await updateStreamSettings(auth, streamName, patch);
  if (!firstApply.ok) {
    findings.push(`Disposable stream ${streamName} settings apply failed.`);
  }
  const afterFirst = await getStreamSchema(auth, streamName);
  const secondApply = await updateStreamSettings(auth, streamName, patch);
  if (!secondApply.ok) {
    findings.push(`Disposable stream ${streamName} second (idempotent) settings apply failed.`);
  }
  const afterSecond = await getStreamSchema(auth, streamName);
  const diffs = diffSettings(
    { data_retention: 7 },
    normalizeServerSettings(afterSecond?.settings ?? {}, []),
  );
  if (
    !isNoChange(diffs) ||
    afterFirst?.settings?.data_retention !== afterSecond?.settings?.data_retention
  ) {
    findings.push(`Disposable stream ${streamName} settings apply was not idempotent.`);
  }

  // supported deletion capability test (whole-stream delete — see
  // docs/openobserve-v0.91-stream-capabilities.md capability #4/#12: this
  // pinned build only supports whole-stream delete, not time-range delete,
  // and this repo's own probing found no deletion job/status API to poll —
  // there is nothing to bound-poll against for deletion on this build).
  const guarded = validateDestructiveTarget({ org: ORG_ID, streamName, confirmed: true });
  if (!guarded.allowed) {
    findings.push(`Disposable stream ${streamName} delete was unexpectedly refused by the guard.`);
    return findings;
  }
  const deletion = await deleteStream(auth, streamName);
  if (!deletion.ok) {
    findings.push(`Disposable stream ${streamName} deletion failed (status ${deletion.status}).`);
  }

  // cleanup verification
  const afterDelete = await getStreamSchema(auth, streamName);
  if (afterDelete !== null) {
    findings.push(`Disposable stream ${streamName} still exists after deletion.`);
  }
  return findings;
}

async function waitUntil(
  predicate,
  { timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return false;
}

// --- 6. management-plane isolation ----------------------------------------

function httpsGetStatus(url, authHeader) {
  const ca = readFileSync(caCertPath, "utf8");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: "GET", ca, headers: { Authorization: authHeader } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function verifyManagementIsolation(auth) {
  const findings = [];
  const paths = [
    "/api/default/streams",
    "/config",
    "/api/default/rumtoken",
    "/api/default/_search?type=logs",
    "/api/organizations",
  ];
  for (const path of paths) {
    const status = await httpsGetStatus(`${DEMO_URL}${path}`, auth).catch(() => 0);
    if (status < 400) {
      findings.push(
        `Management path ${path} was unexpectedly reachable via the browser-facing proxy (status ${status}).`,
      );
    }
  }
  return findings;
}

// --- 7. real Chromium/Firefox schema canary -------------------------------

function escapeSqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

async function driveCanaryBrowser(browserType, testRunId) {
  const browser = await browserType.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript((runId) => {
      globalThis.__CHICEK_TEST_RUN_ID__ = runId;
    }, testRunId);
    const page = await context.newPage();
    await page.goto(DEMO_URL);
    await page.waitForTimeout(300);

    async function click(id) {
      await page.getByTestId(`scenario-${id}`).click();
      await page.waitForTimeout(250);
    }

    await click("consent-grant");
    await click("initialize-runtime-config");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await click("initialize-runtime-config");
    await click("consent-grant");
    await click("record-action");
    await click("runtime-error");
    await page.waitForTimeout(200);
    await click("unhandled-rejection");
    await page.waitForTimeout(200);
    await click("success-request");
    await click("server-error");
    await click("long-task");
    // The real vendor RUM and Logs SDKs both batch on a fixed ~30-35s
    // internal timer, not per-call and not on any of Playwright's own
    // page-close/visibilitychange hooks — confirmed by directly timing the
    // real RUM/logs intake request bodies during this stage's development
    // (Playwright network interception, exact millisecond timestamps): a
    // shorter wait (even 15s) plus a synthetic `visibilitychange` produced
    // no request at all, while both the RUM batch and the Logs batch
    // reliably reached the network together at ~35s after page load, every
    // time. Relying on browser.close() to force an early flush (an earlier
    // version of this wait did exactly that, at 800ms-5000ms) was a race
    // that silently dropped the pending batch under real load — it is not
    // real product behavior and this script does not approximate it.
    await page.waitForTimeout(36_000);
  } finally {
    await browser.close();
  }
}

async function pollSearch(auth, sql, startUs, { expectHits = true } = {}) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let latest;
  do {
    latest = await search(auth, sql, { startUs, endUs: NOW_US() });
    if (latest.status === 200 && (!expectHits || latest.hits.length > 0)) return latest;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  return latest;
}

// Deliberately NOT a UUID, and deliberately kept under 32 total characters:
// the real, already-shipped sanitization client-side sanitizer
// (packages/browser-observability/src/sanitization/detectors/patterns.js)
// redacts both UUID-shaped values (UUID_PATTERN) and any 32-or-more-char
// run matching `[A-Za-z0-9+/_-]{32,}` (BASE64_TOKEN_PATTERN — note this
// class includes `-`, so hyphens do not break a match) as token-shaped
// before an event ever leaves the browser. Both were confirmed the hard
// way during this stage's development by capturing real RUM intake
// request bodies directly: a crypto.randomUUID()-based run-id vanished
// entirely (UUID_PATTERN), and even a hyphen-separated
// "stream-lifecycle-chromium-<8 chars>-<6 chars>" id (exactly 32 characters end to
// end) still vanished (BASE64_TOKEN_PATTERN) — while the shorter
// "stream-lifecycle-firefox-..." variant (31 characters) survived untouched. A
// short, fixed per-engine code keeps every generated id safely under the
// 32-character threshold regardless of which Playwright browser name is
// passed in.
const BROWSER_SHORT_CODE = Object.freeze({ chromium: "cr", firefox: "ff" });

function generateBrowserSafeRunId(browserLabel) {
  const shortCode = BROWSER_SHORT_CODE[browserLabel] ?? browserLabel.slice(0, 2);
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `st15-${shortCode}-${timePart}-${randomPart}`;
}

async function runBrowserCanary(browserLabel, browserType, auth) {
  const findings = [];
  const testRunId = generateBrowserSafeRunId(browserLabel);
  const startedUs = NOW_US() - 5_000_000;

  await driveCanaryBrowser(browserType, testRunId);

  const scopeFilter =
    `service='${escapeSqlLiteral(DEMO_IDENTITY.service)}' and env='${escapeSqlLiteral(DEMO_IDENTITY.environment)}' ` +
    `and version='${escapeSqlLiteral(DEMO_IDENTITY.version)}' and application_id='${escapeSqlLiteral(RUM_APPLICATION_ID)}'`;

  const views = await pollSearch(
    auth,
    `select * from _rumdata where ${scopeFilter} and type='view' limit 5`,
    startedUs,
  );
  const errors = await pollSearch(
    auth,
    `select * from _rumdata where ${scopeFilter} and type='error' limit 10`,
    startedUs,
  );
  const resources = await pollSearch(
    auth,
    `select * from _rumdata where ${scopeFilter} and type='resource' limit 10`,
    startedUs,
  );
  const actions = await pollSearch(
    auth,
    `select * from _rumdata where test_run_id='${escapeSqlLiteral(testRunId)}' and type='action' limit 10`,
    startedUs,
  );
  const logs = await pollSearch(
    auth,
    `select * from _rumlog where ${scopeFilter} limit 10`,
    startedUs,
  );
  // Long-task native events are best-effort (see roadmap: "deterministik
  // mümkünse" — only if deterministically achievable): a real
  // PerformanceObserver longtask entry depends on the browser engine
  // actually crossing its ~50ms threshold, which this script does not
  // hard-require.
  const longTasks = await pollSearch(
    auth,
    `select * from _rumdata where ${scopeFilter} and type='long_task' limit 5`,
    startedUs,
    { expectHits: false },
  );

  if (views.hits.length === 0)
    findings.push(`[${browserLabel}] no real view record ingested into _rumdata.`);
  if (errors.hits.length === 0)
    findings.push(`[${browserLabel}] no real error record ingested into _rumdata.`);
  if (resources.hits.length === 0)
    findings.push(`[${browserLabel}] no real resource record ingested into _rumdata.`);
  if (actions.hits.length === 0)
    findings.push(`[${browserLabel}] no real action record ingested into _rumdata.`);
  if (logs.hits.length === 0)
    findings.push(`[${browserLabel}] no real browser-log record ingested into _rumlog.`);

  log(
    `  [${browserLabel}] best-effort native long_task record: ${longTasks.hits.length > 0 ? "observed" : "not observed this run (non-blocking)"}.`,
  );

  const rumdataDefinition = loadStreamDefinition("rumdata");
  const rumlogDefinition = loadStreamDefinition("rumlog");
  const allRumdataHits = [
    ...views.hits,
    ...errors.hits,
    ...resources.hits,
    ...actions.hits,
    ...longTasks.hits,
  ];
  const schemaFindings = [];
  for (const hit of allRumdataHits) {
    schemaFindings.push({ validation: validateRecord(rumdataDefinition.contract, hit) });
    if (!isRecordClean(validateRecord(rumdataDefinition.contract, hit))) {
      findings.push(
        `[${browserLabel}] _rumdata record failed schema-contract validation: ${hit.type}/${hit._o2_id ?? "?"}.`,
      );
    }
  }
  for (const hit of logs.hits) {
    schemaFindings.push({ validation: validateRecord(rumlogDefinition.contract, hit) });
    if (!isRecordClean(validateRecord(rumlogDefinition.contract, hit))) {
      findings.push(`[${browserLabel}] _rumlog record failed schema-contract validation.`);
    }
  }
  const drift = classifyDrift({ schemaFindings });
  if (
    drift.overall === DRIFT_CLASS.SECURITY_DRIFT ||
    drift.overall === DRIFT_CLASS.BREAKING_SCHEMA_DRIFT
  ) {
    findings.push(`[${browserLabel}] canary schema drift classification: ${drift.overall}.`);
  }

  // correlation correlation must still be attached to real actions.
  for (const hit of actions.hits) {
    if (!hit.chicek_correlation_session_id || !hit.chicek_correlation_epoch_id) {
      findings.push(`[${browserLabel}] real action record missing correlation correlation fields.`);
    }
  }

  // Replay must never be recorded (replay-disabled, still Security Blocked).
  const replay = await search(auth, "select * from _rumreplay limit 1", {
    startUs: startedUs,
    endUs: NOW_US(),
  });
  if (replay.status === 200 && replay.hits.length > 0) {
    findings.push(
      `[${browserLabel}] session replay data was found — replay must never be recorded.`,
    );
  }

  return findings;
}

// --- orchestration ---------------------------------------------------------

export async function verifyStreams() {
  const findings = [];
  const secretValues = readAdminSecretValues();
  const auth = readAdminAuthHeader();

  log("test:streams — running coverage-checked unit suite for scripts/lab/streams/...");
  const unit = runStreamsUnitCoverage();
  if (!unit.pass) {
    findings.push("scripts/lab/streams/ unit+coverage suite failed.");
    return { pass: false, findings };
  }

  // Provisioning runs first, not after a read-back check: this gate must
  // be self-sufficient right after a fresh `pnpm lab:purge && pnpm lab:up`
  // (the roadmap's own gate order runs `test:streams` *before*
  // `lab:streams:provision`), and a freshly-created canonical stream
  // starts at the server's own defaults (retention/query-range 0), not
  // this repo's desired manifest state — that is expected drift on a
  // brand-new stream, not a failure to report.
  log("test:streams — provisioning idempotency (two runs)...");
  await ensureCanonicalStreamsExist(auth);
  const firstProvision = await streamsProvision();
  const secondProvision = await streamsProvision();
  for (const result of secondProvision) {
    if (result.outcome !== "NO_CHANGE") {
      findings.push(
        `Second provision run for ${result.stream} was not NO_CHANGE (${result.outcome}).`,
      );
    }
  }
  if (
    firstProvision.some(
      (r) => r.outcome === "REFUSED_NOT_PROVABLY_NON_DESTRUCTIVE" || r.outcome === "APPLY_FAILED",
    )
  ) {
    findings.push("First provision run reported a failure/refusal on a canonical stream.");
  }

  log("test:streams — canonical stream settings/schema/pipeline read-back...");
  const verifyResults = await streamsVerify();
  for (const result of verifyResults) {
    if (!result.exists || result.drift.overall !== DRIFT_CLASS.NO_DRIFT) {
      findings.push(
        `Canonical stream ${result.stream} drift: ${result.drift?.overall ?? "MISSING"}.`,
      );
    }
  }

  log("test:streams — canonical destructive guard...");
  findings.push(...(await verifyCanonicalDestructiveGuardBlocked(auth)));

  log("test:streams — disposable stream lifecycle...");
  const lifecycleRunId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  findings.push(...(await verifyDisposableLifecycle(auth, lifecycleRunId)));

  log("test:streams — management-plane isolation...");
  findings.push(...(await verifyManagementIsolation(auth)));

  log("test:streams — Chromium real schema canary...");
  findings.push(...(await runBrowserCanary("chromium", chromium, auth)));

  log("test:streams — Firefox real schema canary...");
  findings.push(...(await runBrowserCanary("firefox", firefox, auth)));

  assertNoSecretLeak(findings, secretValues);
  return { pass: findings.length === 0, findings };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:streams");
    const result = await verifyStreams();
    if (result.pass) {
      log("\n✔ stream-lifecycle stream lifecycle verification PASSED.");
    } else {
      logError("\n✖ stream-lifecycle stream lifecycle verification FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:streams FAILED: ${error.message}`);
    process.exit(1);
  }
}
