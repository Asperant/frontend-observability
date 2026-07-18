import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function fail(message) {
  console.error(`Toolchain check FAILED: ${message}`);
  process.exit(1);
}

const expectedNodeVersion = readFileSync(`${repoRoot}.node-version`, "utf8").trim();
const actualNodeVersion = process.version.replace(/^v/, "");

if (actualNodeVersion.split(".")[0] !== expectedNodeVersion.split(".")[0]) {
  fail(
    `Node.js major version mismatch: .node-version=${expectedNodeVersion} actual=${actualNodeVersion}`,
  );
}

const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8"));
const expectedPnpm = pkg.packageManager?.split("@")[1];

if (!expectedPnpm) {
  fail("package.json is missing a pinned packageManager field for pnpm.");
}

let actualPnpm;
try {
  actualPnpm = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  fail(`Unable to run "pnpm --version": ${error.message}`);
}

if (actualPnpm.split(".")[0] !== expectedPnpm.split(".")[0]) {
  fail(`pnpm major version mismatch: expected=${expectedPnpm} actual=${actualPnpm}`);
}

console.log(`Toolchain OK: node=${actualNodeVersion} pnpm=${actualPnpm}`);
