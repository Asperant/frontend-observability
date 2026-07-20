// CLI + reusable function: samples `docker stats --no-stream` for every
// chicek-lab service, parsed through scripts/performance/lib/docker-stats-parser.js
// (100%-coverage-gated pure logic) and optionally aggregated through
// scripts/performance/lib/metrics-collector.js. This module itself is
// I/O-only (spawns docker), not coverage-gated — mirrors
// scripts/lab/streams/admin-client.mjs's own split.

import { spawnSync } from "node:child_process";

import { COMPOSE_PROJECT_NAME, SERVICES, log, logError } from "../lab/common.mjs";
import { parseDockerStatsSnapshot } from "./lib/docker-stats-parser.js";

function containerNameFor(service) {
  return `${COMPOSE_PROJECT_NAME}-${service}-1`;
}

/**
 * One instantaneous snapshot across every chicek-lab service, keyed by
 * service name. `docker stats` has been observed to occasionally return a
 * transient EOF against the Docker socket under concurrent load (soak/
 * benchmark runs sample this repeatedly while other requests are in
 * flight); one bounded retry absorbs that without masking a real failure.
 */
export function sampleContainerMetrics({ retriesLeft = 1 } = {}) {
  const names = SERVICES.map(containerNameFor);
  const result = spawnSync("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...names], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (retriesLeft > 0) return sampleContainerMetrics({ retriesLeft: retriesLeft - 1 });
    throw new Error(`docker stats failed (exit ${result.status}): ${result.stderr ?? ""}`);
  }
  const snapshot = parseDockerStatsSnapshot(result.stdout);
  const byService = {};
  for (const service of SERVICES) {
    const containerName = containerNameFor(service);
    const entry = snapshot.find((item) => item.name === containerName);
    if (entry) byService[service] = entry;
  }
  return byService;
}

/**
 * Open file-descriptor count for one service's container, counted via
 * `docker exec <container> ls /proc/1/fd` (works without extra tooling in
 * every one of this lab's minimal images). Returns null rather than
 * throwing if the container can't be exec'd into (e.g. currently restarting) —
 * callers treat a null sample as "skip this point", not as a hard failure.
 */
export function sampleFileDescriptorCount(service) {
  const result = spawnSync(
    "docker",
    ["exec", containerNameFor(service), "sh", "-c", "ls /proc/1/fd | wc -l"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : null;
}

/** Restart count for one service, from `docker inspect`'s RestartCount field. */
export function readRestartCount(service) {
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{.RestartCount}}", containerNameFor(service)],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : null;
}

/** Restart counts for every chicek-lab service, keyed by service name. */
export function readAllRestartCounts() {
  const counts = {};
  for (const service of SERVICES) counts[service] = readRestartCount(service);
  return counts;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    const metrics = sampleContainerMetrics();
    log(JSON.stringify(metrics, null, 2));
  } catch (error) {
    logError(`collect-container-metrics FAILED: ${error.message}`);
    process.exit(1);
  }
}
