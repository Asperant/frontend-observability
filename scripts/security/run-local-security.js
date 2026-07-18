import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { scanForSecrets } from "./scan-secrets.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

let failed = false;

function step(label, fn) {
  console.log(`\n▶ security: ${label}`);
  try {
    fn();
    console.log(`✔ ${label} passed`);
  } catch (error) {
    console.error(`✖ ${label} failed: ${error.message}`);
    failed = true;
  }
}

step("secret scan (repo source and fixtures)", () => {
  const findings = scanForSecrets([repoRoot]);
  if (findings.length > 0) {
    for (const finding of findings) console.error(`  - [${finding.rule}] ${finding.file}`);
    throw new Error(`${findings.length} finding(s)`);
  }
});

step("bundle secret scan (dist output)", () => {
  const distDirs = [
    `${repoRoot}packages/browser-observability/dist`,
    `${repoRoot}apps/demo-frontend/dist`,
  ].filter((dir) => existsSync(dir));

  if (distDirs.length === 0) {
    console.warn("  (no dist/ output found; run `pnpm build` first for a full bundle scan)");
    return;
  }

  const findings = scanForSecrets(distDirs);
  if (findings.length > 0) {
    for (const finding of findings) console.error(`  - [${finding.rule}] ${finding.file}`);
    throw new Error(`${findings.length} finding(s)`);
  }
});

step("dependency audit (production, high and critical)", () => {
  execFileSync("pnpm", ["audit", "--audit-level", "high", "--prod"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
});

if (failed) {
  console.error("\nsecurity:local FAILED");
  process.exit(1);
}

console.log("\nsecurity:local passed.");
