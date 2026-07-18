import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const distDir = join(repoRoot, "packages/browser-observability/dist");

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

const manifestFileName = "artifact-manifest.json";
const files = readdirSync(distDir)
  .filter((name) => statSync(join(distDir, name)).isFile())
  .filter((name) => name !== manifestFileName)
  .sort();

const manifest = {
  schemaVersion: "1.0.0",
  package: "@chicek/browser-observability",
  generatedAt: new Date().toISOString(),
  builtWithNode: process.version.replace(/^v/, ""),
  algorithm: "sha256",
  files: files.map((name) => ({
    path: name,
    sha256: sha256(join(distDir, name)),
    bytes: statSync(join(distDir, name)).size,
  })),
};

writeFileSync(join(distDir, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifestFileName} for ${files.length} file(s) in ${distDir}`);
