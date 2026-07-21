import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertExactLabToolchain,
  emailSecretPath,
  log,
  logError,
  passwordSecretPath,
  repoRoot,
} from "./common.mjs";

const OPENOBSERVE_ADMIN_URL = "http://127.0.0.1:5080";
const ORG_ID = "default";
const STREAM_TYPE = "logs";
const SANITIZATION_DIR = join(repoRoot, "infrastructure/openobserve/sanitization");

const FUNCTIONS = {
  rum: "chicek_rum_sanitize_v1",
  rumlog: "chicek_rumlog_sanitize_v1",
  correlation: "chicek_correlation_normalize_v1",
  cleanup: "chicek_sanitization_cleanup_v1",
};

const PIPELINES = [
  {
    name: "chicek_rumdata_sanitize_pipeline_v1",
    stream: "_rumdata",
    sanitizeFunction: FUNCTIONS.rum,
  },
  {
    name: "chicek_rumlog_sanitize_pipeline_v1",
    stream: "_rumlog",
    sanitizeFunction: FUNCTIONS.rumlog,
  },
];

function readAdminCredentials() {
  return {
    email: readFileSync(emailSecretPath, "utf8").trim(),
    password: readFileSync(passwordSecretPath, "utf8").trim(),
  };
}

function basicAuthHeader(email, password) {
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

function hashSource(source) {
  return createHash("sha256").update(canonicalVrlSource(source)).digest("hex");
}

function canonicalVrlSource(source) {
  const trimmed = String(source).trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed} \n .`;
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
    body = { message: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

async function ensureFunction(baseUrl, auth, name, source) {
  const existing = await getFunction(baseUrl, auth, name);
  const payload = { name, function: source, trans_type: 0 };
  if (existing && canonicalVrlSource(getFunctionSource(existing)) === canonicalVrlSource(source)) {
    return { ok: true, changed: false };
  }

  const path = existing ? `/api/${ORG_ID}/functions/${name}` : `/api/${ORG_ID}/functions`;
  const response = await apiFetch(baseUrl, auth, path, {
    method: existing ? "PUT" : "POST",
    body: JSON.stringify(payload),
  });
  if ([200, 201, 204].includes(response.status)) {
    return { ok: true, changed: true };
  }
  if (!existing && response.status === 400) {
    const update = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/functions/${name}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if ([200, 201, 204].includes(update.status)) {
      return { ok: true, changed: true };
    }
  }
  return { ok: false, status: response.status };
}

async function getFunction(baseUrl, auth, name) {
  const functions = await listFunctions(baseUrl, auth);
  return functions.find((item) => item.name === name);
}

async function listFunctions(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/functions`, { method: "GET" });
  if (Array.isArray(response.body)) return response.body;
  if (Array.isArray(response.body?.list)) return response.body.list;
  if (Array.isArray(response.body?.functions)) return response.body.functions;
  return [];
}

function getFunctionSource(fn) {
  return String(fn?.function ?? fn?.vrl ?? fn?.source ?? "");
}

async function ensurePipeline(baseUrl, auth, spec) {
  const desired = createPipelinePayload(spec);
  const existing = await listPipelines(baseUrl, auth);
  const related = existing.filter((pipeline) => isRelatedPipeline(pipeline, spec));
  const desiredExisting = related.find((pipeline) => pipeline.name === spec.name);

  if (desiredExisting && pipelineSemanticallyEquals(desiredExisting, desired)) {
    const stale = related.filter(
      (pipeline) => getPipelineId(pipeline) !== getPipelineId(desiredExisting),
    );
    for (const pipeline of stale) {
      const removed = await deletePipeline(baseUrl, auth, pipeline);
      if (!removed.ok) return removed;
    }
    return { ok: true, changed: stale.length > 0 };
  }

  for (const pipeline of related) {
    const removed = await deletePipeline(baseUrl, auth, pipeline);
    if (!removed.ok) return removed;
  }

  const response = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/pipelines`, {
    method: "POST",
    body: JSON.stringify(desired),
  });
  if (![200, 201, 204].includes(response.status)) {
    return { ok: false, status: response.status, message: "create pipeline failed" };
  }
  return { ok: true, changed: true };
}

async function deletePipeline(baseUrl, auth, pipeline) {
  const pipelineId = getPipelineId(pipeline);
  if (!pipelineId) {
    return { ok: false, message: `pipeline ${pipeline?.name ?? "unknown"} has no API id` };
  }
  const response = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/pipelines/${pipelineId}`, {
    method: "DELETE",
  });
  return [200, 204, 404].includes(response.status)
    ? { ok: true }
    : { ok: false, status: response.status, message: `delete pipeline ${pipeline.name} failed` };
}

function getPipelineId(pipeline) {
  return pipeline?.pipeline_id ?? pipeline?.id ?? "";
}

function createPipelinePayload({ name, stream, sanitizeFunction }) {
  return {
    name,
    enabled: true,
    kind: "user",
    source: {
      source_type: "realtime",
      org_id: ORG_ID,
      stream_type: STREAM_TYPE,
      stream_name: stream,
    },
    nodes: [
      createPipelineNode(
        "source",
        "stream",
        "input",
        { org_id: ORG_ID, stream_type: STREAM_TYPE, stream_name: stream },
        0,
      ),
      createPipelineNode(
        "classify-and-sanitize",
        "function",
        "default",
        { name: sanitizeFunction, after_flatten: false },
        220,
      ),
      createPipelineNode(
        "allow-sanitized",
        "condition",
        "default",
        {
          version: 2,
          conditions: {
            filterType: "group",
            logicalOperator: "AND",
            conditions: [
              {
                filterType: "condition",
                column: "_chicek_drop",
                operator: "=",
                value: false,
                logicalOperator: "AND",
              },
            ],
          },
        },
        440,
      ),
      createPipelineNode(
        "correlation-normalize",
        "function",
        "default",
        { name: FUNCTIONS.correlation, after_flatten: false },
        660,
      ),
      createPipelineNode(
        "cleanup",
        "function",
        "default",
        { name: FUNCTIONS.cleanup, after_flatten: false },
        880,
      ),
      createPipelineNode(
        "destination",
        "stream",
        "output",
        { org_id: ORG_ID, stream_type: STREAM_TYPE, stream_name: stream },
        1100,
      ),
    ],
    edges: [
      createPipelineEdge("source", "classify-and-sanitize"),
      createPipelineEdge("classify-and-sanitize", "allow-sanitized"),
      createPipelineEdge("allow-sanitized", "correlation-normalize"),
      createPipelineEdge("correlation-normalize", "cleanup"),
      createPipelineEdge("cleanup", "destination"),
    ],
  };
}

function createPipelineNode(id, type, ioType, data, x) {
  return {
    id,
    type,
    io_type: ioType,
    position: { x, y: 0 },
    data: { node_type: type, ...data },
  };
}

function createPipelineEdge(source, target) {
  return { id: `e${source}-${target}`, source, target };
}

async function listPipelines(baseUrl, auth) {
  const response = await apiFetch(baseUrl, auth, `/api/${ORG_ID}/pipelines`, { method: "GET" });
  if (Array.isArray(response.body?.list)) return response.body.list;
  if (Array.isArray(response.body)) return response.body;
  return [];
}

function isRelatedPipeline(pipeline, spec) {
  if (pipeline?.name === spec.name) return true;
  const streams = pipelineStreams(pipeline);
  return streams.some(
    (stream) => stream.stream_type === STREAM_TYPE && stream.stream_name === spec.stream,
  );
}

function pipelineStreams(pipeline) {
  const streams = [];
  if (pipeline?.source?.source_type === "realtime") streams.push(pipeline.source);
  for (const node of pipeline?.nodes ?? []) {
    if (node?.data?.node_type === "stream") streams.push(node.data);
  }
  return streams;
}

function pipelineSemanticallyEquals(actual, desired) {
  if (actual?.name !== desired.name) return false;
  if (actual?.enabled !== true) return false;
  if (actual?.kind !== undefined && actual.kind !== "user") return false;
  if (!sameRealtimeSource(actual.source, desired.source)) return false;
  if (!sameNodes(actual.nodes, desired.nodes)) return false;
  if (!sameEdges(actual.edges, desired.edges)) return false;
  return true;
}

function sameRealtimeSource(actual, desired) {
  return (
    actual?.source_type === desired.source_type &&
    actual?.org_id === desired.org_id &&
    actual?.stream_type === desired.stream_type &&
    actual?.stream_name === desired.stream_name
  );
}

function sameNodes(actualNodes = [], desiredNodes = []) {
  const actual = normalizeNodes(actualNodes);
  const desired = normalizeNodes(desiredNodes);
  return JSON.stringify(actual) === JSON.stringify(desired);
}

function normalizeNodes(nodes) {
  return [...nodes]
    .map((node) => ({
      id: node.id,
      io_type: node.io_type,
      data: normalizeNodeData(node.data),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeNodeData(data = {}) {
  if (data.node_type === "function") {
    return {
      node_type: "function",
      name: data.name,
      after_flatten: data.after_flatten ?? false,
    };
  }
  if (data.node_type === "stream") {
    return {
      node_type: "stream",
      org_id: data.org_id,
      stream_type: data.stream_type,
      stream_name: data.stream_name,
    };
  }
  if (data.node_type === "condition") {
    return {
      node_type: "condition",
      version: data.version,
      conditions: data.conditions,
    };
  }
  return data;
}

function sameEdges(actualEdges = [], desiredEdges = []) {
  const normalize = (edges) => {
    return [...edges]
      .map((edge) => ({ source: edge.source, target: edge.target }))
      .sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`));
  };
  return JSON.stringify(normalize(actualEdges)) === JSON.stringify(normalize(desiredEdges));
}

async function verifyProvisioned(baseUrl, auth, sources) {
  const findings = [];
  const functions = await listFunctions(baseUrl, auth);
  for (const [name, source] of Object.entries(sources)) {
    const matches = functions.filter((fn) => fn.name === name);
    if (matches.length !== 1) {
      findings.push(`Function ${name} read-back count is ${matches.length}, expected 1.`);
      continue;
    }
    const actualHash = hashSource(getFunctionSource(matches[0]));
    const expectedHash = hashSource(source);
    if (actualHash !== expectedHash) {
      findings.push(`Function ${name} source hash drift detected.`);
    }
  }

  const pipelines = await listPipelines(baseUrl, auth);
  const related = pipelines.filter((pipeline) => {
    return PIPELINES.some((spec) => isRelatedPipeline(pipeline, spec));
  });
  if (related.length !== PIPELINES.length) {
    findings.push(`Pipeline read-back count is ${related.length}, expected ${PIPELINES.length}.`);
  }
  for (const spec of PIPELINES) {
    const desired = createPipelinePayload(spec);
    const matches = related.filter((pipeline) => pipeline.name === spec.name);
    if (matches.length !== 1) {
      findings.push(`Pipeline ${spec.name} read-back count is ${matches.length}, expected 1.`);
      continue;
    }
    if (!pipelineSemanticallyEquals(matches[0], desired)) {
      findings.push(`Pipeline ${spec.name} semantic read-back verification failed.`);
    }
  }
  return findings;
}

export async function provisionSanitization({ baseUrl = OPENOBSERVE_ADMIN_URL, auth } = {}) {
  const resolvedAuth =
    auth ??
    (() => {
      const { email, password } = readAdminCredentials();
      return basicAuthHeader(email, password);
    })();
  const rumVrl = readFileSync(join(SANITIZATION_DIR, "rum.vrl"), "utf8");
  const rumlogVrl = readFileSync(join(SANITIZATION_DIR, "rumlog.vrl"), "utf8");
  const correlationVrl = readFileSync(join(SANITIZATION_DIR, "correlation.vrl"), "utf8");
  const cleanupVrl = readFileSync(join(SANITIZATION_DIR, "cleanup.vrl"), "utf8");
  const functionSources = {
    [FUNCTIONS.rum]: rumVrl,
    [FUNCTIONS.rumlog]: rumlogVrl,
    [FUNCTIONS.correlation]: correlationVrl,
    [FUNCTIONS.cleanup]: cleanupVrl,
  };

  log("lab:provision-sanitization — verifying OpenObserve function API support...");
  for (const [name, source] of Object.entries(functionSources)) {
    const result = await ensureFunction(baseUrl, resolvedAuth, name, source);
    if (!result.ok) {
      return {
        pass: false,
        findings: [
          `OpenObserve did not accept function create-or-update for ${name}; sanitization backstop is not active.`,
        ],
      };
    }
  }

  log("lab:provision-sanitization — verifying OpenObserve realtime pipeline API support...");
  for (const spec of PIPELINES) {
    const result = await ensurePipeline(baseUrl, resolvedAuth, spec);
    if (!result.ok) {
      return {
        pass: false,
        findings: [
          `OpenObserve did not accept canonical realtime user pipeline ${spec.name}; sanitization backstop is not active.`,
        ],
      };
    }
  }

  const findings = await verifyProvisioned(baseUrl, resolvedAuth, functionSources);
  return { pass: findings.length === 0, findings };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:provision-sanitization");
    const result = await provisionSanitization();
    if (result.pass) {
      log("lab:provision-sanitization complete.");
    } else {
      logError("lab:provision-sanitization FAILED:");
      for (const finding of result.findings) logError(`  - ${finding}`);
    }
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`lab:provision-sanitization FAILED: ${error.message}`);
    process.exit(1);
  }
}
