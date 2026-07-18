import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkExactNodeVersion, checkExactPnpmVersion } from "./toolchain.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function fail(message) {
  console.error(`Toolchain check FAILED: ${message}`);
  process.exit(1);
}

const expectedNodeVersion = readFileSync(`${repoRoot}.node-version`, "utf8").trim();
const nodeResult = checkExactNodeVersion(expectedNodeVersion, process.version);
if (!nodeResult.ok) {
  fail(nodeResult.message);
}

const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8"));

let actualPnpm;
try {
  actualPnpm = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  fail(`Unable to run "pnpm --version": ${error.message}`);
}

const pnpmResult = checkExactPnpmVersion(pkg.packageManager, actualPnpm);
if (!pnpmResult.ok) {
  fail(pnpmResult.message);
}

console.log(`Toolchain OK: node=${nodeResult.actual} pnpm=${pnpmResult.actual}`);
