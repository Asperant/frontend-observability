import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const distDir = join(repoRoot, "packages/browser-observability/dist");

export const manifestFileName = "artifact-manifest.json";

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

// No wall-clock timestamp, process ID, or other run-specific value belongs
// here: this manifest is packaged into the published tarball, and the same
// source/toolchain/lockfile must always produce the same bytes (see
// docs/production-handoff.md, "Reproducible browser artifact").
export function buildManifest(dir) {
  const files = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .filter((name) => name !== manifestFileName)
    .sort();

  return {
    schemaVersion: "1.0.0",
    package: "@frontend-observability/browser-observability",
    builtWithNode: process.version.replace(/^v/, ""),
    algorithm: "sha256",
    files: files.map((name) => ({
      path: name,
      sha256: sha256(join(dir, name)),
      bytes: statSync(join(dir, name)).size,
    })),
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const manifest = buildManifest(distDir);
  writeFileSync(join(distDir, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestFileName} for ${manifest.files.length} file(s) in ${distDir}`);
}
