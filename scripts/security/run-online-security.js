import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// This script is the only place in the toolchain allowed to require
// registry/network access. `pnpm run verify` must stay fully offline, so
// anything that talks to a registry (vulnerability advisories, etc.) lives
// here instead of in scripts/security/run-local-security.js.

let failed = false;

function step(label, fn) {
  console.log(`\n▶ security:online: ${label}`);
  try {
    fn();
    console.log(`✔ ${label} passed`);
  } catch (error) {
    console.error(`✖ ${label} failed: ${error.message}`);
    failed = true;
  }
}

step("dependency audit (production, high and critical, registry-backed)", () => {
  execFileSync("pnpm", ["audit", "--audit-level", "high", "--prod"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
});

if (failed) {
  console.error("\nsecurity:online FAILED");
  process.exit(1);
}

console.log("\nsecurity:online passed.");
