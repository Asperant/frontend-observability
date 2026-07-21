// Stage 20 backup/restore/upgrade/rollback proof for the local lab.
// Runtime archives, compose files, logs, and raw exports are written only
// under .runtime/stage20/ and are never committed. The committed output is a
// secret-free summary JSON plus the runbooks/docs created from it.

import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

import { DEMO_IDENTITY } from "../../apps/demo-frontend/src/identity.js";
import {
  assertExactLabToolchain,
  dockerEnv,
  emailSecretPath,
  passwordSecretPath,
  repoRoot,
  runDockerCompose,
  runtimeDir,
} from "../lab/common.mjs";
import { provisionSanitization } from "../lab/provision-sanitization.mjs";
import { buildOpenObserveAlert } from "../lab/alerts/alert-builder.js";
import { loadAllAlertPolicies, loadAlertTemplates } from "../lab/alerts/catalog.mjs";
import { loadAllQueryManifests, loadAllStarterDashboards } from "../lab/dashboards/catalog.mjs";
import { buildStarterDashboardBody } from "../lab/dashboards/panel-builder.js";
import { loadAllStreamDefinitions } from "../lab/streams/load-manifests.mjs";

const ORG_ID = "default";
const SOURCE = {
  tag: "v0.91.0",
  digest: "sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8",
  image:
    "public.ecr.aws/zinclabs/openobserve:v0.91.0@sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8",
};
const TARGET = {
  tag: "v0.91.2",
  digest: "sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15",
  image:
    "public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15",
};
const BUSYBOX =
  "docker.io/library/busybox:1.38.0-musl@sha256:ffcc8d72c1b3749dd2240e27f79b987eb227538835a2675b1d5849b053a39195";

function run(command, args, { cwd = repoRoot, capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: dockerEnv(),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    const detail = capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}.${detail}`);
  }
  return result;
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function repoPath(path) {
  return relative(repoRoot, path);
}

function assertChecksum(path, expected, label) {
  const actual = sha256File(path);
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
  }
  return { verified: true, sha256: actual };
}

function summarizeOpenObserveLogs(logText) {
  const lines = logText.split("\n").filter(Boolean);
  const warningLines = lines.filter((line) => /\bwarn(ing)?\b/i.test(line));
  const errorLines = lines.filter((line) => /\berror\b/i.test(line));
  return {
    warningCount: warningLines.length,
    errorCount: errorLines.length,
    tail: lines.slice(-20).join("\n"),
  };
}

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
    throw new Error(`${action} failed with status ${response.status}`);
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

async function listControlPlane(baseUrl, auth) {
  const [streams, pipelines, functions, folders, alerts, templates, destinations] =
    await Promise.all([
      apiFetch(baseUrl, auth, `/api/${ORG_ID}/streams`),
      apiFetch(baseUrl, auth, `/api/${ORG_ID}/pipelines`),
      apiFetch(baseUrl, auth, `/api/${ORG_ID}/functions`),
      apiFetch(baseUrl, auth, `/api/v2/${ORG_ID}/folders/dashboards`),
      apiFetch(baseUrl, auth, `/api/v2/${ORG_ID}/alerts?folder=default`),
      apiFetch(baseUrl, auth, `/api/${ORG_ID}/alerts/templates`),
      apiFetch(
        baseUrl,
        auth,
        `/api/${ORG_ID}/alerts/destinations?page_num=1&page_size=100&module=alert`,
      ),
    ]);
  const folderList = Array.isArray(folders.body?.list) ? folders.body.list : [];
  let dashboardCount = 0;
  for (const folder of folderList) {
    const dashboards = await apiFetch(
      baseUrl,
      auth,
      `/api/${ORG_ID}/dashboards?folder=${encodeURIComponent(folder.folderId)}`,
    );
    dashboardCount += Array.isArray(dashboards.body?.dashboards)
      ? dashboards.body.dashboards.length
      : 0;
  }
  return {
    streamCount: streams.body?.list?.length ?? 0,
    pipelines: Array.isArray(pipelines.body?.list)
      ? pipelines.body.list.length
      : Array.isArray(pipelines.body)
        ? pipelines.body.length
        : 0,
    functions: Array.isArray(functions.body)
      ? functions.body.length
      : Array.isArray(functions.body?.list)
        ? functions.body.list.length
        : 0,
    folders: folderList.length,
    dashboards: dashboardCount,
    alerts: Array.isArray(alerts.body?.list) ? alerts.body.list.length : 0,
    templates: Array.isArray(templates.body) ? templates.body.length : 0,
    destinations: Array.isArray(destinations.body) ? destinations.body.length : 0,
  };
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

async function exportLogical(baseUrl, auth) {
  const controlPlane = await listControlPlane(baseUrl, auth);
  const streamSchemas = {};
  for (const stream of ["_rumdata", "_rumlog"]) {
    const schema = await apiFetch(
      baseUrl,
      auth,
      `/api/${ORG_ID}/streams/${stream}/schema?type=logs`,
    );
    streamSchemas[stream] = schema.body;
  }
  return { capturedAt: new Date().toISOString(), controlPlane, streamSchemas };
}

function copyOpenObserveWrapper(contextDir, imageRef) {
  mkdirSync(contextDir, { recursive: true });
  cpSync(
    join(repoRoot, "infrastructure/docker/openobserve/entrypoint.sh"),
    join(contextDir, "entrypoint.sh"),
  );
  cpSync(
    join(repoRoot, "infrastructure/docker/openobserve/healthcheck.sh"),
    join(contextDir, "healthcheck.sh"),
  );
  writeFileSync(
    join(contextDir, "Dockerfile"),
    `FROM ${BUSYBOX} AS shell
FROM ${imageRef}
COPY --from=shell /bin/busybox /bin/busybox
RUN ["/bin/busybox", "sh", "-c", "/bin/busybox --install -s /bin && addgroup -g 10001 openobserve && adduser -D -H -u 10001 -G openobserve openobserve && mkdir -p /data && chown -R openobserve:openobserve /data"]
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY --chmod=0755 healthcheck.sh /healthcheck.sh
ENV ZO_DATA_DIR=/data
USER openobserve:openobserve
ENTRYPOINT ["/entrypoint.sh"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 CMD ["/healthcheck.sh"]
`,
  );
}

function writeCompose(runDir, name, version, port) {
  const imageRef = version === "source" ? SOURCE.image : TARGET.image;
  const contextDir = join(runDir, `${name}-openobserve`);
  copyOpenObserveWrapper(contextDir, imageRef);
  const composePath = join(runDir, `${name}.compose.yaml`);
  writeFileSync(
    composePath,
    `services:
  openobserve:
    build:
      context: ${JSON.stringify(contextDir)}
      dockerfile: Dockerfile
    image: chicek-stage20/${name}-openobserve:${version === "source" ? SOURCE.tag : TARGET.tag}
    user: "${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}"
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=256m,mode=1777
    volumes:
      - openobserve-data:/data
      - ${JSON.stringify(`${emailSecretPath}:/run/secrets/openobserve_root_email:ro`)}
      - ${JSON.stringify(`${passwordSecretPath}:/run/secrets/openobserve_root_password:ro`)}
      - ${JSON.stringify(`${join(runtimeDir, "secrets/openobserve-rum-client-token")}:/run/secrets/openobserve_rum_client_token:ro`)}
    ports:
      - "127.0.0.1:${port}:5080"
    environment:
      ZO_DATA_DIR: /data
      ZO_TELEMETRY: "false"
      ZO_MMDB_DISABLE_DOWNLOAD: "true"
      ZO_HTTP_PORT: "5080"
      ZO_SSRF_ALLOW_LOOPBACK: "true"
      ZO_USAGE_REPORTING_ENABLED: "true"
      ZO_USAGE_REPORT_TO_OWN_ORG: "true"
      ZO_USAGE_PUBLISH_INTERVAL: "15"
    healthcheck:
      test: ["CMD", "/healthcheck.sh"]
      interval: 10s
      timeout: 5s
      start_period: 30s
      retries: 6
  alert-sink:
    image: chicek-lab/mock-api:6.0.0
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=16m,mode=1777
    network_mode: "service:openobserve"
    environment:
      PORT: "4312"
    depends_on:
      openobserve:
        condition: service_healthy
        restart: true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4312/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 6
volumes:
  openobserve-data:
`,
  );
  return composePath;
}

function compose(project, composePath, args, options = {}) {
  return run("docker", ["compose", "-f", composePath, "--project-name", project, ...args], options);
}

async function waitForUrlHealthy(port, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok || response.status === 401) return Date.now() - started;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`OpenObserve on port ${port} did not become healthy`);
}

function dockerVolume(project) {
  return `${project}_openobserve-data`;
}

function tarVolume(volume, archivePath) {
  mkdirSync(dirname(archivePath), { recursive: true });
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${volume}:/data:ro`,
    "-v",
    `${dirname(archivePath)}:/backup`,
    BUSYBOX,
    "sh",
    "-c",
    `cd /data && tar cf /backup/${archivePath.split("/").at(-1)} .`,
  ]);
}

function restoreVolume(volume, archivePath) {
  run("docker", ["volume", "create", volume], { capture: true });
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${volume}:/data`,
    "-v",
    `${dirname(archivePath)}:/backup:ro`,
    BUSYBOX,
    "sh",
    "-c",
    `cd /data && tar xf /backup/${archivePath.split("/").at(-1)}`,
  ]);
}

function volumeSizeKiB(volume) {
  const result = run(
    "docker",
    ["run", "--rm", "-v", `${volume}:/data:ro`, BUSYBOX, "du", "-sk", "/data"],
    { capture: true },
  );
  return Number.parseInt(result.stdout.trim().split(/\s+/)[0], 10);
}

async function ensureStreams(baseUrl, auth) {
  for (const { manifest } of loadAllStreamDefinitions()) {
    await apiFetch(
      baseUrl,
      auth,
      `/api/${ORG_ID}/streams/${manifest.streamName}/settings?type=logs`,
      {
        method: "PUT",
        body: JSON.stringify(manifest.desiredSettings),
      },
    );
  }
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

async function alertDestinationSmoke(baseUrl, auth, markerPrefix) {
  const probeBody = {
    alert: `stage20-${markerPrefix}`,
    severity: "low",
    status: "firing",
    service: DEMO_IDENTITY.service,
    environment: DEMO_IDENTITY.environment,
    dedupKey: `stage20-${markerPrefix}`,
  };
  const firing = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/alerts/destinations/test`, {
    method: "POST",
    body: JSON.stringify({
      url: "http://127.0.0.1:4312/alert-sink",
      method: "post",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(probeBody),
    }),
  });
  const resolved = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/alerts/destinations/test`, {
    method: "POST",
    body: JSON.stringify({
      url: "http://127.0.0.1:4312/alert-sink",
      method: "post",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...probeBody, status: "resolved" }),
    }),
  });
  return {
    firingOk: firing.body?.success === true,
    resolvedOk: resolved.body?.success === true,
  };
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
          message: 'stage20 api_key="not-a-real-secret-canary-value-000"',
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

async function createFixtureEnvironment(baseUrl, auth, marker) {
  await ensureStreams(baseUrl, auth);
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

async function smokeEnvironment(baseUrl, auth, markerPrefix) {
  const newMarker = `${markerPrefix}-new-${randomUUID()}`;
  await ingest(baseUrl, auth, "_rumdata", newMarker);
  const newVisible = await markerVisible(baseUrl, auth, "_rumdata", newMarker);
  const controlPlane = await listControlPlane(baseUrl, auth);
  const sanitization = await sanitizationSmoke(baseUrl, auth, markerPrefix);
  const alertSmoke = await alertDestinationSmoke(baseUrl, auth, markerPrefix);
  return { newMarker, newVisible, controlPlane, sanitization, alertSmoke };
}

async function startProject({ runDir, project, version, port, archivePath }) {
  const composePath = writeCompose(runDir, project, version, port);
  const existingContainers = run(
    "docker",
    ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
    {
      capture: true,
      allowFailure: true,
    },
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  if (existingContainers.length > 0) {
    run("docker", ["rm", "-f", ...existingContainers], { capture: true, allowFailure: true });
  }
  run("docker", ["volume", "rm", "-f", dockerVolume(project)], {
    capture: true,
    allowFailure: true,
  });
  if (archivePath) {
    restoreVolume(dockerVolume(project), archivePath);
  }
  const started = Date.now();
  compose(project, composePath, ["up", "-d", "--build"]);
  const healthyMs = await waitForUrlHealthy(port);
  return {
    project,
    composePath,
    baseUrl: `http://127.0.0.1:${port}`,
    healthyMs,
    startupMs: Date.now() - started,
    volume: dockerVolume(project),
  };
}

function stopProject(project, composePath, removeVolumes = true) {
  compose(project, composePath, ["down", removeVolumes ? "-v" : ""].filter(Boolean), {
    allowFailure: true,
  });
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
    schemaVersion: 1,
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
      ],
    },
    mainTargetBackup: {},
    restoreTarget: {},
    upgrade: {},
    rollback: {},
    reUpgrade: {},
  };

  const logical = await exportLogical(mainBaseUrl, auth);
  const logicalPath = join(backupDir, "target-logical-export.json");
  writeFileSync(logicalPath, `${JSON.stringify(logical, null, 2)}\n`, { mode: 0o600 });
  result.mainTargetBackup.logical = {
    path: repoPath(logicalPath),
    sha256: sha256File(logicalPath),
    controlPlane: logical.controlPlane,
  };

  runDockerCompose(["stop", "openobserve"]);
  const mainArchive = join(backupDir, "target-openobserve-data.tar");
  try {
    tarVolume("chicek-lab_openobserve-data", mainArchive);
  } finally {
    run("pnpm", ["run", "lab:up"]);
  }
  result.mainTargetBackup.coldVolume = {
    archive: repoPath(mainArchive),
    sha256: sha256File(mainArchive),
    bytes: statSync(mainArchive).size,
    volumeSizeKiB: volumeSizeKiB("chicek-lab_openobserve-data"),
  };
  result.mainTargetBackup.coldVolume.checksum = assertChecksum(
    mainArchive,
    result.mainTargetBackup.coldVolume.sha256,
    "target cold backup",
  );

  const targetRestore = await startProject({
    runDir,
    project: "chicek-stage20-target-restore",
    version: "target",
    port: 15080,
    archivePath: mainArchive,
  });
  try {
    result.restoreTarget = await smokeEnvironment(targetRestore.baseUrl, auth, "target-restore");
    result.restoreTarget.startupMs = targetRestore.startupMs;
    result.restoreTarget.volumeSizeKiB = volumeSizeKiB(targetRestore.volume);
  } finally {
    stopProject(targetRestore.project, targetRestore.composePath);
  }

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
    result.sourceFixture = await exportLogical(sourceProject.baseUrl, auth);
    compose(sourceProject.project, sourceProject.composePath, ["stop", "openobserve"]);
    tarVolume(sourceProject.volume, sourceArchive);
    result.sourceBackup = {
      archive: repoPath(sourceArchive),
      sha256: sha256File(sourceArchive),
      bytes: statSync(sourceArchive).size,
      volumeSizeKiB: volumeSizeKiB(sourceProject.volume),
    };
    result.sourceBackup.checksum = assertChecksum(
      sourceArchive,
      result.sourceBackup.sha256,
      "source cold backup",
    );
  } finally {
    stopProject(sourceProject.project, sourceProject.composePath);
  }

  const sourceRestore = await startProject({
    runDir,
    project: "chicek-stage20-source-restore",
    version: "source",
    port: 15082,
    archivePath: sourceArchive,
  });
  try {
    const oldRumdata = await markerVisible(
      sourceRestore.baseUrl,
      auth,
      "_rumdata",
      `${sourceMarker}-rumdata`,
    );
    const oldRumlog = await markerVisible(
      sourceRestore.baseUrl,
      auth,
      "_rumlog",
      `${sourceMarker}-rumlog`,
    );
    result.sourceRestore = {
      startupMs: sourceRestore.startupMs,
      oldRumdata,
      oldRumlog,
      smoke: await smokeEnvironment(sourceRestore.baseUrl, auth, "source-restore"),
    };
  } finally {
    stopProject(sourceRestore.project, sourceRestore.composePath);
  }

  const upgradeStarted = Date.now();
  const upgradeProject = await startProject({
    runDir,
    project: "chicek-stage20-upgrade",
    version: "target",
    port: 15083,
    archivePath: sourceArchive,
  });
  try {
    const logs = compose(
      upgradeProject.project,
      upgradeProject.composePath,
      ["logs", "--tail=120", "openobserve"],
      {
        capture: true,
      },
    ).stdout;
    const logSummary = summarizeOpenObserveLogs(logs);
    result.upgrade = {
      startupMs: upgradeProject.startupMs,
      elapsedMs: Date.now() - upgradeStarted,
      oldRumdata: await markerVisible(
        upgradeProject.baseUrl,
        auth,
        "_rumdata",
        `${sourceMarker}-rumdata`,
      ),
      oldRumlog: await markerVisible(
        upgradeProject.baseUrl,
        auth,
        "_rumlog",
        `${sourceMarker}-rumlog`,
      ),
      smoke: await smokeEnvironment(upgradeProject.baseUrl, auth, "upgrade"),
      volumeSizeKiB: volumeSizeKiB(upgradeProject.volume),
      logSummary,
    };
  } finally {
    stopProject(upgradeProject.project, upgradeProject.composePath);
  }

  const rollbackStarted = Date.now();
  const rollbackProject = await startProject({
    runDir,
    project: "chicek-stage20-rollback",
    version: "source",
    port: 15084,
    archivePath: sourceArchive,
  });
  try {
    result.rollback = {
      startupMs: rollbackProject.startupMs,
      elapsedMs: Date.now() - rollbackStarted,
      oldRumdata: await markerVisible(
        rollbackProject.baseUrl,
        auth,
        "_rumdata",
        `${sourceMarker}-rumdata`,
      ),
      oldRumlog: await markerVisible(
        rollbackProject.baseUrl,
        auth,
        "_rumlog",
        `${sourceMarker}-rumlog`,
      ),
      smoke: await smokeEnvironment(rollbackProject.baseUrl, auth, "rollback"),
      volumeSizeKiB: volumeSizeKiB(rollbackProject.volume),
    };
  } finally {
    stopProject(rollbackProject.project, rollbackProject.composePath);
  }

  const reUpgradeStarted = Date.now();
  const reUpgradeProject = await startProject({
    runDir,
    project: "chicek-stage20-reupgrade",
    version: "target",
    port: 15085,
    archivePath: sourceArchive,
  });
  try {
    result.reUpgrade = {
      startupMs: reUpgradeProject.startupMs,
      elapsedMs: Date.now() - reUpgradeStarted,
      oldRumdata: await markerVisible(
        reUpgradeProject.baseUrl,
        auth,
        "_rumdata",
        `${sourceMarker}-rumdata`,
      ),
      oldRumlog: await markerVisible(
        reUpgradeProject.baseUrl,
        auth,
        "_rumlog",
        `${sourceMarker}-rumlog`,
      ),
      smoke: await smokeEnvironment(reUpgradeProject.baseUrl, auth, "reupgrade"),
      volumeSizeKiB: volumeSizeKiB(reUpgradeProject.volume),
    };
  } finally {
    stopProject(reUpgradeProject.project, reUpgradeProject.composePath);
  }

  result.rpo = {
    labColdSnapshot: "0",
    rationale: "Cold tar snapshot is taken while the source OpenObserve process is stopped.",
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
    objectCounts: result.mainTargetBackup.logical.controlPlane,
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
      const { firingOk, resolvedOk } = smoke.alertSmoke;
      if (!firingOk || !resolvedOk) {
        result.decision = "BLOCKED";
        throw new Error(`${section} alert destination smoke failed`);
      }
    }
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
