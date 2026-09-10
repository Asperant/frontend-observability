#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds and packages @frontend-observability/browser-observability twice, independently,
// and proves the resulting tarballs are byte-for-byte identical. Guards
// against a regression of the reproducible-build property documented in
// docs/production-handoff.md — never runs against the committed release
// artifact under .artifacts/browser-package/, so it can never delete it.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageDir = join(repoRoot, "packages/browser-observability");
const distDir = join(packageDir, "dist");

const ALLOWED_ENTRY =
  /^package\/(dist\/(index|adapter-openobserve|artifact-manifest)\.js(on)?|package\.json|README\.md|LICENSE)$/;

function buildAndPack(destDir) {
  rmSync(distDir, { recursive: true, force: true });
  execFileSync("pnpm", ["--filter", "@frontend-observability/browser-observability", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execFileSync("node", ["scripts/build/generate-artifact-manifest.js"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execFileSync("node", ["scripts/build/verify-build-gate.js"], { cwd: repoRoot, stdio: "inherit" });
  execFileSync("pnpm", ["pack", "--pack-destination", destDir], {
    cwd: packageDir,
    stdio: "inherit",
  });
  const tarball = readdirSync(destDir)
    .filter((name) => /^frontend-observability-browser-observability-.*\.tgz$/.test(name))
    .sort()
    .at(-1);
  if (!tarball) throw new Error(`browser package tarball was not created in ${destDir}`);
  return join(destDir, tarball);
}

function tarEntries(tarballPath) {
  return execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .sort();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function extractedFileHashes(tarballPath, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir]);
  const hashes = {};
  for (const entry of tarEntries(tarballPath)) {
    hashes[entry] = sha256File(join(extractDir, entry));
  }
  return hashes;
}

const workDir = mkdtempSync(join(tmpdir(), "frontend-observability-browser-observability-repro-"));
try {
  const run1Dir = join(workDir, "run-1");
  const run2Dir = join(workDir, "run-2");
  const extract1Dir = join(workDir, "extract-1");
  const extract2Dir = join(workDir, "extract-2");
  for (const dir of [run1Dir, run2Dir, extract1Dir, extract2Dir]) {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("package:reproducibility — build 1/2 (clean dist, build, pack)...");
  const tarball1 = buildAndPack(run1Dir);
  const sha1 = sha256File(tarball1);
  const entries1 = tarEntries(tarball1);

  console.log("package:reproducibility — build 2/2 (clean dist, build, pack)...");
  const tarball2 = buildAndPack(run2Dir);
  const sha2 = sha256File(tarball2);
  const entries2 = tarEntries(tarball2);

  const errors = [];

  for (const entry of new Set([...entries1, ...entries2])) {
    if (!ALLOWED_ENTRY.test(entry)) errors.push(`forbidden tarball entry: ${entry}`);
  }

  if (JSON.stringify(entries1) !== JSON.stringify(entries2)) {
    errors.push(
      `tarball entry lists differ.\n  run-1: ${JSON.stringify(entries1)}\n  run-2: ${JSON.stringify(entries2)}`,
    );
  }

  if (sha1 !== sha2) {
    errors.push(`tarball SHA-256 differs. run-1=${sha1} run-2=${sha2}`);
  }

  if (errors.length === 0) {
    const hashes1 = extractedFileHashes(tarball1, extract1Dir);
    const hashes2 = extractedFileHashes(tarball2, extract2Dir);
    for (const entry of entries1) {
      if (hashes1[entry] !== hashes2[entry]) {
        errors.push(
          `extracted file content differs for ${entry}: run-1=${hashes1[entry]} run-2=${hashes2[entry]}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("package:reproducibility FAILED:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      { schemaVersion: "1.0.0", reproducible: true, sha256: sha1, entries: entries1 },
      null,
      2,
    ),
  );
  console.log("package:reproducibility PASSED: two independent builds produced identical bytes.");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
