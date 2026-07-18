import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const browserObservabilityDir = join(repoRoot, "packages/browser-observability");

// Exact versions pinned in pnpm-workspace.yaml's catalog. Consumer fixtures
// are installed with plain npm outside the pnpm workspace on purpose, so
// they cannot resolve the "catalog:" protocol and need literal versions.
export const PINNED_VERSIONS = Object.freeze({
  vite: "8.1.5",
  "@vitejs/plugin-react": "6.0.3",
  react: "19.2.7",
  "react-dom": "19.2.7",
});

export function ensureBrowserObservabilityBuilt() {
  const distIndex = join(browserObservabilityDir, "dist", "index.js");
  if (!existsSync(distIndex)) {
    execFileSync("pnpm", ["--filter", "@chicek/browser-observability", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  return distIndex;
}

/**
 * Builds and `pnpm pack`s @chicek/browser-observability, returning the
 * absolute path to the resulting tarball. Consumer tests install from this
 * tarball (never from workspace source) so packaging mistakes cannot hide.
 */
export function packBrowserObservability() {
  ensureBrowserObservabilityBuilt();
  const packOutputDir = mkdtempSync(join(tmpdir(), "chicek-pack-"));
  execFileSync("pnpm", ["pack", "--pack-destination", packOutputDir], {
    cwd: browserObservabilityDir,
    stdio: "inherit",
  });
  const [tarballName] = readdirSync(packOutputDir).filter((name) => name.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(`pnpm pack did not produce a .tgz file in ${packOutputDir}`);
  }
  return join(packOutputDir, tarballName);
}
