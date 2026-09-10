// Shared disposable-OpenObserve-environment infrastructure for recovery
// proofs: pinned source/target image refs, a throwaway compose
// project writer (non-root, read-only, loopback-only, matching the real
// lab's own compose.yaml security posture), cold-volume tar backup/restore,
// and start/stop helpers. Extracted from the original single-file
// verify-openobserve-recovery.mjs so logical-export/restore round-trip tests and the
// full recovery chain proof can both reuse exactly the same disposable
// environment mechanics.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  emailSecretPath,
  openObserveRumIngestTokenSecretPath,
  passwordSecretPath,
  repoRoot,
} from "../lab/common.mjs";

export const SOURCE = {
  tag: "v0.91.0",
  digest: "sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8",
  image:
    "public.ecr.aws/zinclabs/openobserve:v0.91.0@sha256:d611fdb1b07c8a27b5876bdc0c69323e4ea3430daa90feb571a03999aedc77e8",
};
export const TARGET = {
  tag: "v0.91.2",
  digest: "sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15",
  image:
    "public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15",
};
export const BUSYBOX =
  "docker.io/library/busybox:1.38.0-musl@sha256:ffcc8d72c1b3749dd2240e27f79b987eb227538835a2675b1d5849b053a39195";

export function run(command, args, { cwd = repoRoot, capture = false, allowFailure = false } = {}) {
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

function dockerEnv() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 10001;
  const gid = typeof process.getgid === "function" ? process.getgid() : 10001;
  return { ...process.env, LAB_UID: String(uid), LAB_GID: String(gid) };
}

export function repoPath(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length) : path;
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

export function writeCompose(runDir, name, version, port) {
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
    image: frontend-observability-recovery/${name}-openobserve:${version === "source" ? SOURCE.tag : TARGET.tag}
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
      - ${JSON.stringify(`${openObserveRumIngestTokenSecretPath}:/run/secrets/openobserve_rum_ingest_token:ro`)}
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
    image: frontend-observability-lab/http-test-service-fixture:6.0.0
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

export function compose(project, composePath, args, options = {}) {
  return run("docker", ["compose", "-f", composePath, "--project-name", project, ...args], options);
}

export async function waitForUrlHealthy(port, timeoutMs = 120000) {
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

export function dockerVolume(project) {
  return `${project}_openobserve-data`;
}

export function tarVolume(volume, archivePath) {
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

export function restoreVolume(volume, archivePath) {
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

// Clones a live volume's *current* contents into a brand-new volume without
// ever stopping or otherwise touching whatever service owns the source
// volume — a plain `docker run --rm -v src:/from:ro -v dst:/to busybox cp`
// snapshot, safe to run against the canonical main lab volume while it
// keeps serving traffic.
export function cloneVolumeLive(sourceVolume, targetVolume) {
  run("docker", ["volume", "create", targetVolume], { capture: true });
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${sourceVolume}:/from:ro`,
    "-v",
    `${targetVolume}:/to`,
    BUSYBOX,
    "sh",
    "-c",
    "cp -a /from/. /to/",
  ]);
}

export function volumeSizeKiB(volume) {
  const result = run(
    "docker",
    ["run", "--rm", "-v", `${volume}:/data:ro`, BUSYBOX, "du", "-sk", "/data"],
    { capture: true },
  );
  return Number.parseInt(result.stdout.trim().split(/\s+/)[0], 10);
}

export function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export async function startProject({ runDir, project, version, port, archivePath }) {
  const composePath = writeCompose(runDir, project, version, port);
  const existingContainers = run(
    "docker",
    ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
    { capture: true, allowFailure: true },
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

export function stopProject(project, composePath, removeVolumes = true) {
  compose(project, composePath, ["down", removeVolumes ? "-v" : ""].filter(Boolean), {
    allowFailure: true,
  });
}
