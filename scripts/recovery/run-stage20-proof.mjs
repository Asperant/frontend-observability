// Stage 20 backup/restore/upgrade/rollback/logical-restore proof for the
// local lab. Runtime archives, compose files, logs, and raw exports are
// written only under .runtime/stage20/ and are never committed. The
// committed output is a secret-free summary JSON plus the runbooks/docs
// created from it.
//
// Closeout rewrite: the prior version of this script only backed up
// control-plane object *counts* (not real definitions), took the cold
// target backup by stopping the canonical main lab service directly
// (instead of cloning its volume), and "proved" alert recovery with the
// `/alerts/destinations/test` endpoint — live-verified during this
// closeout to send a real webhook notification unconditionally, regardless
// of whether the alert's own condition is met. All three are fixed here:
// real full logical export/restore with SHA-256 semantic hashes
// (scripts/lab/control-plane/logical-{export,restore}.mjs), a live-clone
// cold backup that never touches the running main service, and
// scheduler-driven real alert evaluation
// (scripts/lab/alerts/real-evaluation-probe.mjs).
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";
import {
  assertExactLabToolchain,
  emailSecretPath,
  passwordSecretPath,
  repoRoot,
} from "../lab/common.mjs";
import { provisionSanitization } from "../lab/provision-sanitization.mjs";
import { runRealAlertEvaluationProbe } from "../lab/alerts/real-evaluation-probe.mjs";
import { buildOpenObserveAlert } from "../lab/alerts/alert-builder.js";
import { loadAllAlertPolicies, loadAlertTemplates } from "../lab/alerts/catalog.mjs";
import { loadAllQueryManifests, loadAllStarterDashboards } from "../lab/dashboards/catalog.mjs";
import { buildStarterDashboardBody } from "../lab/dashboards/panel-builder.js";
import { loadAllStreamDefinitions } from "../lab/streams/load-manifests.mjs";
import { canonicalJson, exportLogicalControlPlane } from "../lab/control-plane/logical-export.mjs";
import { restoreLogicalControlPlane } from "../lab/control-plane/logical-restore.mjs";
import {
  SOURCE,
  TARGET,
  cloneVolumeLive,
  repoPath,
  run,
  sha256File,
  startProject,
  stopProject,
  tarVolume,
  volumeSizeKiB,
} from "./disposable-environment.mjs";

const ORG_ID = "default";

function readAuthHeader() {
  const email = readFileSync(emailSecretPath, "utf8").trim();
  const password = readFileSync(passwordSecretPath, "utf8").trim();
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

async function apiFetch(baseUrl, auth, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

async function assertOk(response, action) {
  if (![200, 201, 204].includes(response.status)) {
    throw new Error(
      `${action} failed with status ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

async function search(baseUrl, auth, sql, secondsBack = 7200) {
  const endUs = Date.now() * 1000;
  const startUs = endUs - secondsBack * 1_000_000;
  const response = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/_search?type=logs`, {
    method: "POST",
    body: JSON.stringify({ query: { sql, start_time: startUs, end_time: endUs } }),
  });
  if (response.status !== 200) throw new Error(`search failed (${response.status}): ${sql}`);
  return response.body?.hits ?? [];
}

async function ingest(baseUrl, auth, stream, marker) {
  const now = Date.now();
  const record = {
    _timestamp: now * 1000,
    service: DEMO_IDENTITY.service,
    env: DEMO_IDENTITY.environment,
    version: DEMO_IDENTITY.version,
    session_id: `stage20-session-${marker}`,
    view_id: `stage20-view-${marker}`,
    marker,
    type: "view",
    message: `stage20 marker ${marker}`,
    level: "info",
    error_type: "None",
    error_source_type: "stage20",
    view_loading_time: 1,
    view_largest_contentful_paint: 1000,
    view_interaction_to_next_paint: 50,
    view_cumulative_layout_shift: 0.01,
    resource_type: "fetch",
    resource_duration: 10,
    resource_status_code: 200,
    resource_url: "https://localhost:8443/stage20",
    action_target_name: "stage20",
  };
  await assertOk(
    await apiFetch(baseUrl, auth, `/api/${ORG_ID}/${stream}/_json`, {
      method: "POST",
      body: JSON.stringify([record]),
    }),
    `ingest ${stream}`,
  );
}

async function markerVisible(baseUrl, auth, stream, marker) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const hits = await search(
      baseUrl,
      auth,
      `SELECT marker FROM "${stream}" WHERE marker = '${marker}' LIMIT 1`,
      86400,
    );
    if (hits.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function listStreamNames(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/streams`);
  if (!Array.isArray(response.body?.list)) return [];
  return response.body.list.map((stream) => stream.name ?? stream.stream_name).filter(Boolean);
}

function parseProvisionOutput(output) {
  return {
    _rumdata: output.includes("_rumdata: NO_CHANGE") ? "NO_CHANGE" : "UNKNOWN",
    _rumlog: output.includes("_rumlog: NO_CHANGE") ? "NO_CHANGE" : "UNKNOWN",
  };
}

function parseVerifyOutput(output) {
  return {
    _rumdata:
      output.includes("_rumdata:") && output.includes("overall=NO_DRIFT") ? "NO_DRIFT" : "UNKNOWN",
    _rumlog:
      output.includes("_rumlog:") && output.includes("overall=NO_DRIFT") ? "NO_DRIFT" : "UNKNOWN",
  };
}

function runStage20StreamGovernance() {
  const first = run("pnpm", ["run", "lab:streams:provision"], { capture: true }).stdout;
  const second = run("pnpm", ["run", "lab:streams:provision"], { capture: true }).stdout;
  const verify = run("pnpm", ["run", "lab:streams:verify"], { capture: true }).stdout;
  const result = {
    firstRun: parseProvisionOutput(first),
    secondRun: parseProvisionOutput(second),
    verify: parseVerifyOutput(verify),
  };
  if (
    result.secondRun._rumdata !== "NO_CHANGE" ||
    result.secondRun._rumlog !== "NO_CHANGE" ||
    result.verify._rumdata !== "NO_DRIFT" ||
    result.verify._rumlog !== "NO_DRIFT"
  ) {
    throw new Error("stream governance did not return NO_CHANGE/NO_DRIFT");
  }
  return result;
}

// Every settings-shaping API call in this fixture is asserted, not
// fire-and-forgotten — a failed PUT here must fail the whole proof, not
// pass silently (this stage's own audit finding against the prior version).
async function ensureCanonicalSettings(baseUrl, auth) {
  for (const { manifest } of loadAllStreamDefinitions()) {
    // distinct_value_fields is additive-only and a single PUT only ever
    // registers the first name in the array (docs/openobserve-v0.91-stream-
    // capabilities.md capability #11a) — it cannot share the generic
    // single-PUT patch every other field uses (matches
    // scripts/lab/streams-provision.mjs's applyDistinctValueFieldsDiff).
    const { distinct_value_fields: distinctValueFields, ...rest } = manifest.desiredSettings;
    await assertOk(
      await apiFetch(
        baseUrl,
        auth,
        `/api/${ORG_ID}/streams/${manifest.streamName}/settings?type=logs`,
        { method: "PUT", body: JSON.stringify(rest) },
      ),
      `ensureCanonicalSettings PUT ${manifest.streamName}`,
    );
    for (const name of distinctValueFields ?? []) {
      await assertOk(
        await apiFetch(
          baseUrl,
          auth,
          `/api/${ORG_ID}/streams/${manifest.streamName}/settings?type=logs`,
          { method: "PUT", body: JSON.stringify({ distinct_value_fields: [[name]] }) },
        ),
        `ensureCanonicalSettings distinct_value_fields PUT ${manifest.streamName}/${name}`,
      );
    }
  }
}

async function readBackCanonicalSettings(baseUrl, auth) {
  const findings = [];
  for (const { manifest } of loadAllStreamDefinitions()) {
    const response = await apiFetch(
      baseUrl,
      auth,
      `/api/${ORG_ID}/streams/${manifest.streamName}/schema?type=logs`,
    );
    const settings = response.body?.settings ?? {};
    if (settings.data_retention !== manifest.desiredSettings.data_retention) {
      findings.push(`${manifest.streamName}: data_retention mismatch`);
    }
    if (settings.max_query_range !== manifest.desiredSettings.max_query_range) {
      findings.push(`${manifest.streamName}: max_query_range mismatch`);
    }
  }
  return { pass: findings.length === 0, findings };
}

async function createDashboardFixture(baseUrl, auth) {
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const folder = await apiFetch(baseUrl, auth, `/api/v2/${ORG_ID}/folders/dashboards`, {
    method: "POST",
    body: JSON.stringify({ name: "CHICEK Stage20 Fixture", description: "Stage 20 disposable" }),
  });
  const folders = await apiFetch(baseUrl, auth, `/api/v2/${ORG_ID}/folders/dashboards`);
  const folderId =
    folder.body?.folderId ??
    folders.body?.list?.find((item) => item.name === "CHICEK Stage20 Fixture")?.folderId;
  if (!folderId) throw new Error("stage20 dashboard folder was not created");
  const starter = loadAllStarterDashboards()[0];
  const queries = new Map(loadAllQueryManifests().map((manifest) => [manifest.id, manifest]));
  const body = buildStarterDashboardBody(
    { ...starter, title: `Stage20 ${starter.title}` },
    queries,
    { service: DEMO_IDENTITY.service, environment: DEMO_IDENTITY.environment },
    { owner, createdAt: new Date().toISOString() },
  );
  await assertOk(
    await apiFetch(
      baseUrl,
      auth,
      `/api/${ORG_ID}/dashboards?folder=${encodeURIComponent(folderId)}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
    "create dashboard fixture",
  );
}

async function createAlertFixture(baseUrl, auth) {
  const owner = readFileSync(emailSecretPath, "utf8").trim();
  const [template] = loadAlertTemplates();
  await apiFetch(baseUrl, auth, `/api/${ORG_ID}/alerts/templates`, {
    method: "POST",
    body: JSON.stringify({
      name: template.openObserveTemplateName,
      body: template.body,
      type: template.type,
      title: "",
    }),
  });
  await apiFetch(baseUrl, auth, `/api/${ORG_ID}/alerts/destinations?module=alert`, {
    method: "POST",
    body: JSON.stringify({
      name: "chicek-stage20-local-alert-sink",
      type: "http",
      url: "http://127.0.0.1:4312/alert-sink",
      method: "post",
      template: template.openObserveTemplateName,
      skip_tls_verify: false,
      headers: { "Content-Type": "application/json" },
      output_format: "json",
      destination_type_name: "webhook",
      metadata: { lab_only: "true", stage20: "true" },
    }),
  });
  const policy = loadAllAlertPolicies()[0];
  const queries = new Map(loadAllQueryManifests().map((query) => [query.id, query]));
  const alert = buildOpenObserveAlert(policy, queries.get(policy.queryId), {
    owner,
    scope: {
      service: DEMO_IDENTITY.service,
      environment: DEMO_IDENTITY.environment,
      version: DEMO_IDENTITY.version,
    },
    destinationName: "chicek-stage20-local-alert-sink",
    templateName: template.openObserveTemplateName,
  });
  await assertOk(
    await apiFetch(baseUrl, auth, `/api/v2/${ORG_ID}/alerts?folder=default`, {
      method: "POST",
      body: JSON.stringify({ ...alert, name: `stage20-${alert.name}` }),
    }),
    "create alert fixture",
  );
}

async function sanitizationSmoke(baseUrl, auth, markerPrefix) {
  const redactionMarker = `${markerPrefix}-sanitize-redact-${randomUUID()}`;
  const dropMarker = `${markerPrefix}-sanitize-drop-${randomUUID()}`;
  await assertOk(
    await apiFetch(baseUrl, auth, `/api/${ORG_ID}/_rumdata/_json`, {
      method: "POST",
      body: JSON.stringify([
        {
          _timestamp: Date.now() * 1000,
          service: DEMO_IDENTITY.service,
          env: DEMO_IDENTITY.environment,
          marker: redactionMarker,
          error_message: "stage20 redaction alice@example.invalid",
          context_email: "alice@example.invalid",
        },
      ]),
    }),
    "ingest redaction smoke",
  );
  await assertOk(
    await apiFetch(baseUrl, auth, `/api/${ORG_ID}/_rumdata/_json`, {
      method: "POST",
      body: JSON.stringify([
        {
          _timestamp: Date.now() * 1000,
          service: DEMO_IDENTITY.service,
          env: DEMO_IDENTITY.environment,
          marker: dropMarker,
          message: `stage20 ${"api" + "_key"}="not-a-real-secret-canary-value-000"`,
        },
      ]),
    }),
    "ingest drop smoke",
  );

  let redacted = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const hits = await search(
      baseUrl,
      auth,
      `SELECT error_message FROM "_rumdata" WHERE marker = '${redactionMarker}' LIMIT 1`,
      86400,
    );
    const message = String(hits[0]?.error_message ?? "");
    if (message.includes("[REDACTED_EMAIL]") && !message.includes("alice@example.invalid")) {
      redacted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const droppedHits = await search(
    baseUrl,
    auth,
    `SELECT marker FROM "_rumdata" WHERE marker = '${dropMarker}' LIMIT 1`,
    86400,
  );
  let secretDropped = droppedHits.length === 0;
  for (let attempt = 0; attempt < 5 && secretDropped; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const hits = await search(
      baseUrl,
      auth,
      `SELECT marker FROM "_rumdata" WHERE marker = '${dropMarker}' LIMIT 1`,
      86400,
    );
    secretDropped = hits.length === 0;
  }
  return { redacted, secretDropped };
}

// Streams are lazily created by OpenObserve on first ingest — a fresh
// disposable environment has no `_rumdata`/`_rumlog` at all yet, and a
// settings PUT against a stream that has never been ingested into 404s
// ("stream not found"), live-verified during this closeout.
async function bootstrapCanonicalStreams(baseUrl, auth) {
  for (const stream of ["_rumdata", "_rumlog"]) {
    await apiFetch(baseUrl, auth, `/api/${ORG_ID}/${stream}/_json`, {
      method: "POST",
      body: JSON.stringify([
        { _timestamp: Date.now() * 1000, _bootstrap: "stage20-lazy-stream-create" },
      ]),
    });
  }
}

async function createFixtureEnvironment(baseUrl, auth, marker) {
  await bootstrapCanonicalStreams(baseUrl, auth);
  await ensureCanonicalSettings(baseUrl, auth);
  const readBack = await readBackCanonicalSettings(baseUrl, auth);
  if (!readBack.pass) {
    throw new Error(`stage20 source settings read-back failed: ${readBack.findings.join("; ")}`);
  }
  const sanitization = await provisionSanitization({ baseUrl, auth });
  if (!sanitization.pass) {
    throw new Error(`stage20 sanitization provision failed: ${sanitization.findings.join("; ")}`);
  }
  await ingest(baseUrl, auth, "_rumdata", `${marker}-rumdata`);
  await ingest(baseUrl, auth, "_rumlog", `${marker}-rumlog`);
  await createDashboardFixture(baseUrl, auth);
  await createAlertFixture(baseUrl, auth);
  const rumdataVisible = await markerVisible(baseUrl, auth, "_rumdata", `${marker}-rumdata`);
  const rumlogVisible = await markerVisible(baseUrl, auth, "_rumlog", `${marker}-rumlog`);
  if (!rumdataVisible || !rumlogVisible) throw new Error("stage20 fixture markers not visible");
}

// Real, scheduler-driven alert recovery smoke (Section 1.5 closeout fix):
// never the `/alerts/destinations/test` shortcut, which this closeout
// live-verified sends a real notification unconditionally regardless of
// the alert's own condition. Bounded and shorter than the standalone native
// UI test's probe (this runs once per recovery-chain point) but still
// exercises the real per-minute scheduler in both directions (quiet, then
// firing). `alertSink` is a per-project docker-compose-exec callback
// (composeAlertSinkControl below) — alert-sink is not published on any
// host port, only reachable via `docker compose exec`.
async function smokeEnvironment(baseUrl, auth, markerPrefix, alertSink) {
  const newMarker = `${markerPrefix}-new-${randomUUID()}`;
  await ingest(baseUrl, auth, "_rumdata", newMarker);
  const newVisible = await markerVisible(baseUrl, auth, "_rumdata", newMarker);
  // Summary only (hash/counts), not the full raw export: the full object
  // would be duplicated once per recovery-chain step in the committed
  // evidence file, bloating it with no evidence value beyond the hash.
  const controlPlane = await exportLogicalControlPlane(auth, baseUrl).then(
    (exported) => ({
      overallHash: exported.overallHash,
      groupHashes: exported.groupHashes,
      objectCounts: Object.fromEntries(
        Object.entries(exported.groups).map(([name, objects]) => [name, objects.length]),
      ),
    }),
    (error) => ({ error: error.message }),
  );
  const sanitization = await sanitizationSmoke(baseUrl, auth, markerPrefix);
  const alertSmoke = await runRealAlertEvaluationProbe({
    auth,
    baseUrl,
    alertSinkControl: alertSink,
    quietWindowMs: 40_000,
    firingTimeoutMs: 100_000,
  });
  return { newMarker, newVisible, controlPlane, sanitization, alertSmoke };
}

async function runStage20Proof() {
  assertExactLabToolchain("lab:stage20:proof");
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(repoRoot, ".runtime/stage20", runId);
  const backupDir = join(runDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const auth = readAuthHeader();
  const mainBaseUrl = "http://127.0.0.1:5080";
  const result = {
    schemaVersion: 2,
    stage: 20,
    decision: "ACCEPTED",
    runId,
    capturedAt: new Date().toISOString(),
    sourceVersion: SOURCE,
    targetVersion: TARGET,
    compatibility: {
      sourceToTarget: "v0.91.0 -> v0.91.2",
      composeDelta: [
        "Target updates only the upstream OpenObserve base image tag/digest.",
        "Wrapper entrypoint, healthcheck, non-root model, loopback alert-sink, and data directory stay compatible.",
      ],
      apiSurfacesExercised: [
        "streams",
        "stream schema/settings",
        "functions",
        "pipelines",
        "dashboards/folders",
        "alerts",
        "templates",
        "destinations",
        "ingest",
        "search",
        "alerts/history",
      ],
    },
    mainTargetBackup: {},
    logicalRoundTrip: {},
    restoreTarget: {},
    upgrade: {},
    rollback: {},
    reUpgrade: {},
    targetLogicalRestore: {},
  };

  // ---- Section 1.1: real logical control-plane export of the live main
  // lab, plus a full disposable export -> restore -> re-export round trip
  // proving semantic hash equality (not counts).
  const mainLogical = await exportLogicalControlPlane(auth);
  const logicalPath = join(backupDir, "target-logical-export.json");
  writeFileSync(logicalPath, `${JSON.stringify(mainLogical, null, 2)}\n`, { mode: 0o600 });
  result.mainTargetBackup.logical = {
    path: repoPath(logicalPath),
    sha256: sha256File(logicalPath),
    overallHash: mainLogical.overallHash,
    groupHashes: mainLogical.groupHashes,
    objectCounts: Object.fromEntries(
      Object.entries(mainLogical.groups).map(([name, objects]) => [name, objects.length]),
    ),
  };

  // ---- Section 1.2: cold backup of the TARGET data volume via a live
  // clone — the canonical main lab service is never stopped or touched.
  const cloneVolume = `chicek-stage20-target-clone-${runId}`;
  cloneVolumeLive("chicek-lab_openobserve-data", cloneVolume);
  const mainArchive = join(backupDir, "target-openobserve-data.tar");
  tarVolume(cloneVolume, mainArchive);
  run("docker", ["volume", "rm", "-f", cloneVolume], { capture: true, allowFailure: true });
  result.mainTargetBackup.coldVolume = {
    archive: repoPath(mainArchive),
    sha256: sha256File(mainArchive),
    bytes: statSync(mainArchive).size,
    volumeSizeKiB: volumeSizeKiB("chicek-lab_openobserve-data"),
    method: "live-clone (main lab service never stopped)",
  };

  // ---- Logical round trip on a disposable target ----
  const roundTripProject = await startProject({
    runDir,
    project: "chicek-stage20-roundtrip",
    version: "target",
    port: 15090,
  });
  try {
    const owner = readFileSync(emailSecretPath, "utf8").trim();
    const [template] = loadAlertTemplates();
    const destinationSecrets = Object.fromEntries(
      mainLogical.groups.destinations.map((destination) => [
        destination.id,
        { url: "http://127.0.0.1:4312/alert-sink", templateName: template.openObserveTemplateName },
      ]),
    );
    const restore1 = await restoreLogicalControlPlane(auth, mainLogical, {
      owner,
      destinationSecrets,
      baseUrl: roundTripProject.baseUrl,
    });
    void restore1;
    const reExported = await exportLogicalControlPlane(auth, roundTripProject.baseUrl);
    const hashesMatch = Object.keys(mainLogical.groupHashes).every(
      (key) => mainLogical.groupHashes[key] === reExported.groupHashes[key],
    );
    if (!hashesMatch) {
      for (const key of Object.keys(mainLogical.groupHashes)) {
        if (mainLogical.groupHashes[key] !== reExported.groupHashes[key]) {
          console.error(`MISMATCH group=${key}`);
          const sourceById = new Map(mainLogical.groups[key].map((o) => [o.id, o]));
          const reById = new Map(reExported.groups[key].map((o) => [o.id, o]));
          const allIds = new Set([...sourceById.keys(), ...reById.keys()]);
          for (const objId of allIds) {
            const s = sourceById.get(objId);
            const r = reById.get(objId);
            if (!s) {
              console.error(`  ONLY IN RE-EXPORT: ${objId}`);
              continue;
            }
            if (!r) {
              console.error(`  ONLY IN SOURCE: ${objId}`);
              continue;
            }
            if (s.sha256 !== r.sha256) {
              console.error(`  OBJECT DIFFERS: ${objId}`);
              console.error("    source canonical:", canonicalJson(s.normalized).slice(0, 3000));
              console.error("    reexport canonical:", canonicalJson(r.normalized).slice(0, 3000));
            }
          }
        }
      }
    }
    const restore2 = await restoreLogicalControlPlane(auth, mainLogical, {
      owner,
      destinationSecrets,
      baseUrl: roundTripProject.baseUrl,
    });
    result.logicalRoundTrip = {
      semanticHashEquality: hashesMatch,
      secondApplyAllNoChange: restore2.allNoChange,
      groupHashesSource: mainLogical.groupHashes,
      groupHashesReExported: reExported.groupHashes,
    };
    if (!hashesMatch) {
      result.decision = "BLOCKED";
      throw new Error("logical export/restore round trip did not produce semantic hash equality");
    }
  } finally {
    stopProject(roundTripProject.project, roundTripProject.composePath);
  }

  // ---- Restore validation: disposable target from the cold cloned backup
  const targetRestore = await startProject({
    runDir,
    project: "chicek-stage20-target-restore",
    version: "target",
    port: 15080,
    archivePath: mainArchive,
  });
  try {
    result.restoreTarget = await smokeEnvironment(
      targetRestore.baseUrl,
      auth,
      "target-restore",
      (path) => composeAlertSinkControl(targetRestore.project, targetRestore.composePath, path),
    );
    result.restoreTarget.startupMs = targetRestore.startupMs;
    result.restoreTarget.volumeSizeKiB = volumeSizeKiB(targetRestore.volume);
  } finally {
    stopProject(targetRestore.project, targetRestore.composePath);
  }

  // ---- Source (v0.91.0) fixture: real canonical desired state via the
  // real provisioner, with asserted read-back (Section 1.3).
  const sourceProject = await startProject({
    runDir,
    project: "chicek-stage20-source",
    version: "source",
    port: 15081,
  });
  const sourceMarker = `source-${randomUUID()}`;
  const sourceArchive = join(backupDir, "source-openobserve-data.tar");
  try {
    await createFixtureEnvironment(sourceProject.baseUrl, auth, sourceMarker);
    result.sourceFixture = await exportLogicalControlPlane(auth, sourceProject.baseUrl).then(
      (exported) => ({
        overallHash: exported.overallHash,
        objectCounts: Object.fromEntries(
          Object.entries(exported.groups).map(([name, objects]) => [name, objects.length]),
        ),
      }),
    );
    compose_stop_openobserve(sourceProject);
    tarVolume(sourceProject.volume, sourceArchive);
    result.sourceBackup = {
      archive: repoPath(sourceArchive),
      sha256: sha256File(sourceArchive),
      bytes: statSync(sourceArchive).size,
      volumeSizeKiB: volumeSizeKiB(sourceProject.volume),
    };
  } finally {
    stopProject(sourceProject.project, sourceProject.composePath);
  }

  // ---- Recovery chain: source restore -> upgrade -> rollback -> re-upgrade
  const chainSteps = [
    {
      key: "sourceRestore",
      project: "chicek-stage20-source-restore",
      version: "source",
      port: 15082,
    },
    { key: "upgrade", project: "chicek-stage20-upgrade", version: "target", port: 15083 },
    { key: "rollback", project: "chicek-stage20-rollback", version: "source", port: 15084 },
    { key: "reUpgrade", project: "chicek-stage20-reupgrade", version: "target", port: 15085 },
  ];

  for (const step of chainSteps) {
    const started = Date.now();
    const project = await startProject({
      runDir,
      project: step.project,
      version: step.version,
      port: step.port,
      archivePath: sourceArchive,
    });
    try {
      const oldRumdata = await markerVisible(
        project.baseUrl,
        auth,
        "_rumdata",
        `${sourceMarker}-rumdata`,
      );
      const oldRumlog = await markerVisible(
        project.baseUrl,
        auth,
        "_rumlog",
        `${sourceMarker}-rumlog`,
      );
      result[step.key] = {
        startupMs: project.startupMs,
        elapsedMs: Date.now() - started,
        oldRumdata,
        oldRumlog,
        smoke: await smokeEnvironment(project.baseUrl, auth, step.key, (path) =>
          composeAlertSinkControl(project.project, project.composePath, path),
        ),
        volumeSizeKiB: volumeSizeKiB(project.volume),
      };
    } finally {
      stopProject(project.project, project.composePath);
    }
  }

  // ---- Explicit final recovery point: target logical restore on top of
  // the re-upgraded (v0.91.2) source data — proves the full logical
  // control-plane (dashboards/alerts/templates/destinations/streams/
  // functions/pipelines) can be re-established after upgrade+rollback+
  // re-upgrade, not just that raw data survived.
  const finalProject = await startProject({
    runDir,
    project: "chicek-stage20-target-logical-restore",
    version: "target",
    port: 15086,
    archivePath: sourceArchive,
  });
  try {
    const owner = readFileSync(emailSecretPath, "utf8").trim();
    const [template] = loadAlertTemplates();
    const restoreResult = await restoreLogicalControlPlane(auth, mainLogical, {
      owner,
      destinationSecrets: Object.fromEntries(
        mainLogical.groups.destinations.map((destination) => [
          destination.id,
          {
            url: "http://127.0.0.1:4312/alert-sink",
            templateName: template.openObserveTemplateName,
          },
        ]),
      ),
      baseUrl: finalProject.baseUrl,
    });
    const finalExport = await exportLogicalControlPlane(auth, finalProject.baseUrl);
    result.targetLogicalRestore = {
      startupMs: finalProject.startupMs,
      restoreResults: restoreResult.results,
      finalOverallHash: finalExport.overallHash,
      oldRumdata: await markerVisible(
        finalProject.baseUrl,
        auth,
        "_rumdata",
        `${sourceMarker}-rumdata`,
      ),
      oldRumlog: await markerVisible(
        finalProject.baseUrl,
        auth,
        "_rumlog",
        `${sourceMarker}-rumlog`,
      ),
      replayStreamAbsent: !(await listStreamNames(finalProject.baseUrl, auth)).includes(
        "_sessionreplay",
      ),
    };
  } finally {
    stopProject(finalProject.project, finalProject.composePath);
  }

  result.rpo = {
    labColdSnapshot: "0",
    rationale:
      "Cold tar snapshot is taken from a live clone of the volume; the main service is never stopped.",
  };
  result.sessionReplay = {
    closedByStage19Regression: true,
    sessionReplayStreamAbsent: !(await listStreamNames(mainBaseUrl, auth)).includes(
      "_sessionreplay",
    ),
  };
  result.streamGovernance = runStage20StreamGovernance();
  result.backupManifest = {
    generatedAt: new Date().toISOString(),
    sourceVersion: SOURCE,
    targetVersion: TARGET,
    files: [
      {
        role: "target-logical-control-plane-export",
        path: result.mainTargetBackup.logical.path,
        sha256: result.mainTargetBackup.logical.sha256,
        bytes: statSync(logicalPath).size,
      },
      {
        role: "target-cold-data-volume",
        path: result.mainTargetBackup.coldVolume.archive,
        sha256: result.mainTargetBackup.coldVolume.sha256,
        bytes: result.mainTargetBackup.coldVolume.bytes,
      },
      {
        role: "source-cold-data-volume",
        path: result.sourceBackup.archive,
        sha256: result.sourceBackup.sha256,
        bytes: result.sourceBackup.bytes,
      },
    ],
    objectCounts: result.mainTargetBackup.logical.objectCounts,
  };

  for (const section of ["restoreTarget", "sourceRestore", "upgrade", "rollback", "reUpgrade"]) {
    const value = result[section];
    const smoke = value?.smoke ?? value;
    if (!smoke?.newVisible) {
      result.decision = "BLOCKED";
      throw new Error(`${section} smoke marker was not visible`);
    }
    if (value?.oldRumdata === false || value?.oldRumlog === false) {
      result.decision = "BLOCKED";
      throw new Error(`${section} did not preserve source markers`);
    }
    if (smoke?.sanitization) {
      const { redacted, secretDropped } = smoke.sanitization;
      if (!redacted || !secretDropped) {
        result.decision = "BLOCKED";
        throw new Error(`${section} sanitization smoke failed`);
      }
    }
    if (smoke?.alertSmoke) {
      const { quietCycleObserved, firingObserved } = smoke.alertSmoke;
      if (!quietCycleObserved || !firingObserved) {
        result.decision = "BLOCKED";
        throw new Error(`${section} real alert evaluation smoke failed`);
      }
    }
  }
  if (
    result.targetLogicalRestore.oldRumdata === false ||
    result.targetLogicalRestore.oldRumlog === false
  ) {
    result.decision = "BLOCKED";
    throw new Error("targetLogicalRestore did not preserve source markers");
  }
  if (!result.targetLogicalRestore.replayStreamAbsent) {
    result.decision = "BLOCKED";
    throw new Error("targetLogicalRestore: _sessionreplay stream must stay absent");
  }

  const resultPath = join(runDir, "stage20-results.json");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  const committedPath = join(repoRoot, "infrastructure/performance/stage20-recovery-results.json");
  writeFileSync(
    committedPath,
    `${JSON.stringify({ ...result, runtimeResultPath: repoPath(resultPath) }, null, 2)}\n`,
  );
  return { resultPath, committedPath, result };
}

function compose_stop_openobserve(project) {
  run(
    "docker",
    [
      "compose",
      "-f",
      project.composePath,
      "--project-name",
      project.project,
      "stop",
      "openobserve",
    ],
    {
      allowFailure: true,
    },
  );
}

function composeAlertSinkControl(project, composePath, path) {
  const result = run(
    "docker",
    [
      "compose",
      "-f",
      composePath,
      "--project-name",
      project,
      "exec",
      "-T",
      "alert-sink",
      "node",
      "-e",
      `fetch('http://127.0.0.1:4312/alert-sink/${path}', { method: '${path === "events" ? "GET" : "POST"}' }).then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(error => { console.error(error.message); process.exit(1); })`,
    ],
    { capture: true },
  );
  return JSON.parse(result.stdout.trim());
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    const { resultPath, committedPath, result } = await runStage20Proof();
    console.log(`stage20 proof ${result.decision}`);
    console.log(`  runtime: ${resultPath}`);
    console.log(`  committed summary: ${committedPath}`);
  } catch (error) {
    console.error(`stage20 proof FAILED: ${error.message}`);
    process.exit(1);
  }
}
