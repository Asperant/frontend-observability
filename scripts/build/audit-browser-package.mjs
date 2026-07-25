#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageDir = join(repoRoot, "packages/browser-observability");
const artifactDir = join(repoRoot, ".artifacts/browser-package");
const evidenceDir = join(repoRoot, "evidence/acceptance");
mkdirSync(artifactDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

execFileSync("pnpm", ["--filter", "@chicek/browser-observability", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
execFileSync("node", ["scripts/build/generate-artifact-manifest.js"], {
  cwd: repoRoot,
  stdio: "inherit",
});
execFileSync("node", ["scripts/build/verify-build-gate.js"], { cwd: repoRoot, stdio: "inherit" });

execFileSync("pnpm", ["pack", "--pack-destination", artifactDir], {
  cwd: packageDir,
  stdio: "inherit",
});
const tarball = readdirSync(artifactDir)
  .filter((name) => /^chicek-browser-observability-.*\.tgz$/.test(name))
  .sort()
  .at(-1);
if (!tarball) throw new Error("browser package tarball was not created");

const tarballPath = join(artifactDir, tarball);
const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
const entries = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
  .trim()
  .split(/\n/)
  .filter(Boolean)
  .sort();

const allowed = entries.every((entry) =>
  /^(package\/(dist\/(index|adapter-openobserve|artifact-manifest)\.js(on)?|package\.json|README\.md|LICENSE))$/.test(
    entry,
  ),
);
const forbiddenText = entries
  .join("\n")
  .match(/src\/|tests\/|docs\/|infrastructure\/|scripts\/|\.runtime|stage/i);
if (!allowed || forbiddenText) {
  console.error(JSON.stringify({ tarballPath, sha256, entries }, null, 2));
  throw new Error("browser package tarball contains forbidden entries");
}

const report = {
  schemaVersion: "1.0.0",
  artifact: tarballPath,
  sha256,
  entries,
};
writeFileSync(
  join(evidenceDir, "browser-package-artifact.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
