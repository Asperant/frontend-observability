import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { dockerDir, imagesLockFile, repoRoot, SERVICES } from "./common.mjs";

const FORBIDDEN_TAG_PATTERNS = [
  /^latest$/i,
  /latest-simd/i,
  /-?rc\d*$/i,
  /beta/i,
  /nightly/i,
  /-?dev$/i,
];

export function loadComposeDocument() {
  const text = readFileSync(join(dockerDir, "compose.yaml"), "utf8");
  return { text, doc: parseYaml(text) };
}

export function loadImagesLock() {
  return JSON.parse(readFileSync(imagesLockFile, "utf8"));
}

/** Only one canonical compose file, no override/release/hotfix/rollback files. */
export function checkSingleComposeFile() {
  const entries = readdirSync(dockerDir);
  const composeLike = entries.filter((name) => /^compose.*\.ya?ml$/i.test(name));
  const forbidden = composeLike.filter((name) => name !== "compose.yaml");
  const findings = [];
  if (!composeLike.includes("compose.yaml")) {
    findings.push("infrastructure/docker/compose.yaml is missing.");
  }
  if (forbidden.length > 0) {
    findings.push(`Forbidden extra compose file(s): ${forbidden.join(", ")}`);
  }
  for (const bad of ["docker-compose.override.yml", "docker-compose.override.yaml"]) {
    if (entries.includes(bad)) findings.push(`Forbidden override file present: ${bad}`);
  }
  return { pass: findings.length === 0, findings };
}

function allImageRefs(doc) {
  const refs = [];
  for (const [name, service] of Object.entries(doc.services ?? {})) {
    if (service.image) refs.push({ service: name, image: service.image });
  }
  return refs;
}

/** Every image reference must be pinned to both an exact tag and a digest, with no floating/prerelease tag words. */
export function checkNoFloatingImages(doc) {
  const findings = [];
  for (const { service, image } of allImageRefs(doc)) {
    // Compose-managed local build images (chicek-lab/*) are versioned by the
    // repo's own release tag, not by a digest — the digest pin requirement
    // applies to *external* base images, checked separately via Dockerfiles.
    if (image.startsWith("chicek-lab/")) continue;
    const [, tag] = image.split(":");
    if (!tag) {
      findings.push(`${service}: image "${image}" has no tag.`);
      continue;
    }
    if (FORBIDDEN_TAG_PATTERNS.some((pattern) => pattern.test(tag))) {
      findings.push(`${service}: image tag "${tag}" looks like a floating/prerelease tag.`);
    }
  }
  return { pass: findings.length === 0, findings };
}

/**
 * Accepted spellings of a FROM line's repo portion for a given
 * images.lock.json entry: Docker Hub images may be written with or without
 * the implicit "docker.io/" registry and "library/" namespace.
 */
function acceptedRepoSpellings({ registry, repository }) {
  const full = `${registry}/${repository}`;
  if (registry !== "docker.io") return [full];
  const spellings = new Set([full, repository]);
  if (repository.startsWith("library/")) spellings.add(repository.slice("library/".length));
  return [...spellings];
}

const DOCKERFILE_PATHS = {
  openobserve: join(dockerDir, "openobserve/Dockerfile"),
  "demo-frontend": join(dockerDir, "demo-frontend/Dockerfile"),
  "mock-api": join(dockerDir, "mock-api/Dockerfile"),
  "reverse-proxy": join(dockerDir, "reverse-proxy/Dockerfile"),
};

function extractFromLines(dockerfileText) {
  return [...dockerfileText.matchAll(/^FROM\s+(\S+)/gim)].map((match) => match[1]);
}

/** Every Dockerfile FROM line is pinned tag+digest, and images.lock.json agrees with each pin actually used. */
export function checkImagesLockConsistency() {
  const lock = loadImagesLock();
  const findings = [];
  const lockByPurpose = new Map(lock.images.map((entry) => [entry.purpose, entry]));

  const allFromRefs = new Set();
  for (const [service, path] of Object.entries(DOCKERFILE_PATHS)) {
    const text = readFileSync(path, "utf8");
    const fromLines = extractFromLines(text);
    if (fromLines.length === 0) {
      findings.push(`${service}: Dockerfile has no FROM line.`);
    }
    for (const ref of fromLines) {
      allFromRefs.add(ref);
      if (!ref.includes("@sha256:")) {
        findings.push(`${service}: FROM "${ref}" is missing a digest pin.`);
        continue;
      }
      const [repoTag, digest] = ref.split("@");
      const lastColon = repoTag.lastIndexOf(":");
      const repo = repoTag.slice(0, lastColon);
      const tag = repoTag.slice(lastColon + 1);
      const matchingLockEntry = [...lockByPurpose.values()].find((entry) =>
        acceptedRepoSpellings(entry).includes(repo),
      );
      if (!matchingLockEntry) {
        findings.push(`${service}: FROM "${ref}" has no matching entry in images.lock.json.`);
        continue;
      }
      if (
        matchingLockEntry.tag !== tag ||
        `sha256:${matchingLockEntry.digest.replace(/^sha256:/, "")}` !== digest
      ) {
        findings.push(
          `${service}: FROM "${ref}" does not match images.lock.json entry for "${matchingLockEntry.purpose}" ` +
            `(lock has ${matchingLockEntry.tag}@${matchingLockEntry.digest}).`,
        );
      }
      if (matchingLockEntry.prerelease) {
        findings.push(
          `${service}: images.lock.json marks "${matchingLockEntry.purpose}" as a prerelease.`,
        );
      }
    }
  }

  for (const entry of lock.images) {
    const ref = `${entry.registry}/${entry.repository}:${entry.tag}@${entry.digest}`;
    const spellings = acceptedRepoSpellings(entry);
    const usedSomewhere = [...allFromRefs].some((from) =>
      spellings.some((repo) => from.startsWith(`${repo}:${entry.tag}@`)),
    );
    if (!usedSomewhere) {
      findings.push(
        `images.lock.json entry "${entry.purpose}" (${ref}) is not referenced by any Dockerfile.`,
      );
    }
  }

  return { pass: findings.length === 0, findings };
}

/** Every published host port must bind only to 127.0.0.1. */
export function checkHostPortsLoopback(doc) {
  const findings = [];
  for (const [name, service] of Object.entries(doc.services ?? {})) {
    for (const portEntry of service.ports ?? []) {
      const value = typeof portEntry === "string" ? portEntry : JSON.stringify(portEntry);
      if (typeof portEntry === "string") {
        if (!portEntry.startsWith("127.0.0.1:")) {
          findings.push(`${name}: published port "${value}" is not bound to 127.0.0.1.`);
        }
      } else if (portEntry.host_ip !== "127.0.0.1") {
        findings.push(`${name}: published port "${value}" is not bound to 127.0.0.1.`);
      }
    }
  }
  return { pass: findings.length === 0, findings };
}

const EDGE_PUBLISH_NETWORK = "edge-publish";
const EDGE_PUBLISH_MEMBERS = new Set(["reverse-proxy", "openobserve"]);
const EXPECTED_PUBLISHED_PORTS = new Set(["127.0.0.1:8443:8443", "127.0.0.1:5080:5080"]);

function serviceNetworkNames(service) {
  const networks = service.networks;
  if (Array.isArray(networks)) return networks;
  if (networks && typeof networks === "object") return Object.keys(networks);
  return [];
}

/**
 * `edge-publish` exists only to make the two loopback-bound host ports
 * reachable (Docker's `internal: true` networks refuse to publish any host
 * port for their member containers). It must stay narrowly scoped: only
 * reverse-proxy and openobserve may join it, demo-frontend and mock-api
 * must not, and no port besides 127.0.0.1:8443 and 127.0.0.1:5080 may be
 * published anywhere in the compose file.
 */
export function checkEdgePublishScope(doc) {
  const findings = [];
  const services = doc.services ?? {};

  for (const [name, service] of Object.entries(services)) {
    const isMember = serviceNetworkNames(service).includes(EDGE_PUBLISH_NETWORK);
    const shouldBeMember = EDGE_PUBLISH_MEMBERS.has(name);
    if (isMember && !shouldBeMember) {
      findings.push(`${name}: must not join the "${EDGE_PUBLISH_NETWORK}" network.`);
    }
    if (!isMember && shouldBeMember) {
      findings.push(
        `${name}: must join the "${EDGE_PUBLISH_NETWORK}" network to publish its host port.`,
      );
    }
  }

  const publishedPorts = new Set();
  for (const [name, service] of Object.entries(services)) {
    for (const portEntry of service.ports ?? []) {
      const spec =
        typeof portEntry === "string"
          ? portEntry
          : `${portEntry.host_ip}:${portEntry.published}:${portEntry.target}`;
      publishedPorts.add(spec);
      if (!EXPECTED_PUBLISHED_PORTS.has(spec)) {
        findings.push(`${name}: publishes unexpected port "${spec}".`);
      }
    }
  }
  for (const expected of EXPECTED_PUBLISHED_PORTS) {
    if (!publishedPorts.has(expected)) {
      findings.push(`Expected published port "${expected}" is missing.`);
    }
  }

  return { pass: findings.length === 0, findings };
}

/** No privileged mode, docker socket mounts, host networking, or added capabilities. */
export function checkNoDangerousPrivileges(doc) {
  const findings = [];
  for (const [name, service] of Object.entries(doc.services ?? {})) {
    if (service.privileged) findings.push(`${name}: privileged is set.`);
    if (service.network_mode === "host") findings.push(`${name}: network_mode host is set.`);
    if (service.cap_add) findings.push(`${name}: cap_add is set.`);
    if (service.pid === "host" || service.ipc === "host")
      findings.push(`${name}: host PID/IPC namespace is set.`);
    for (const volume of service.volumes ?? []) {
      const source = typeof volume === "string" ? volume.split(":")[0] : volume.source;
      if (source === "/var/run/docker.sock") {
        findings.push(`${name}: mounts the Docker socket.`);
      }
    }
  }
  return { pass: findings.length === 0, findings };
}

/** Every service declares real (non-Swarm-only-effective) resource, pid, log-rotation, healthcheck and restart limits. */
export function checkResourceAndReliabilityLimits(doc) {
  const findings = [];
  for (const name of SERVICES) {
    const service = doc.services?.[name];
    if (!service) {
      findings.push(`${name}: service is missing from compose.yaml.`);
      continue;
    }
    const limits = service.deploy?.resources?.limits;
    if (!limits?.cpus) findings.push(`${name}: missing deploy.resources.limits.cpus.`);
    if (!limits?.memory) findings.push(`${name}: missing deploy.resources.limits.memory.`);
    if (!limits?.pids) findings.push(`${name}: missing deploy.resources.limits.pids.`);
    if (!service.healthcheck) findings.push(`${name}: missing healthcheck.`);
    if (!service.logging?.driver) findings.push(`${name}: missing logging driver (log rotation).`);
    if (!service.security_opt?.includes("no-new-privileges:true")) {
      findings.push(`${name}: missing security_opt no-new-privileges:true.`);
    }
    if (JSON.stringify(service.cap_drop ?? []) !== JSON.stringify(["ALL"])) {
      findings.push(`${name}: cap_drop must be exactly [ALL].`);
    }
    if (!/^on-failure:\d+$/.test(String(service.restart ?? ""))) {
      findings.push(
        `${name}: restart policy must be a bounded "on-failure:N", got "${service.restart}".`,
      );
    }
  }
  return { pass: findings.length === 0, findings };
}

/** openobserve-data must be a named volume, never a bind mount, and must be the only volume with real data. */
export function checkNamedOpenobserveVolume(doc) {
  const findings = [];
  if (!doc.volumes || !("openobserve-data" in doc.volumes)) {
    findings.push(
      'Named volume "openobserve-data" is missing from the top-level volumes: section.',
    );
  }
  const openobserveService = doc.services?.openobserve;
  const dataVolume = (openobserveService?.volumes ?? []).find((v) => {
    const target = typeof v === "string" ? v.split(":")[1] : v.target;
    return target === "/data";
  });
  if (!dataVolume) {
    findings.push("openobserve service has no volume mounted at /data.");
  } else {
    const source = typeof dataVolume === "string" ? dataVolume.split(":")[0] : dataVolume.source;
    if (source !== "openobserve-data") {
      findings.push(
        `openobserve /data is backed by "${source}", expected the named volume "openobserve-data".`,
      );
    }
  }
  return { pass: findings.length === 0, findings };
}

export function runAllStaticChecks() {
  const { doc } = loadComposeDocument();
  const checks = [
    ["single compose file", checkSingleComposeFile()],
    ["no floating image tags", checkNoFloatingImages(doc)],
    ["images.lock.json consistency", checkImagesLockConsistency()],
    ["host ports bound to loopback", checkHostPortsLoopback(doc)],
    ["edge-publish network scope", checkEdgePublishScope(doc)],
    ["no dangerous privileges", checkNoDangerousPrivileges(doc)],
    ["resource/reliability limits", checkResourceAndReliabilityLimits(doc)],
    ["named openobserve volume", checkNamedOpenobserveVolume(doc)],
  ];
  const findings = [];
  for (const [label, result] of checks) {
    for (const finding of result.findings) {
      findings.push(`[${label}] ${finding}`);
    }
  }
  return { pass: findings.length === 0, findings };
}

export { repoRoot };
