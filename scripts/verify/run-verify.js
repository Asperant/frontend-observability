import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// `pnpm run verify` must never require registry or internet access. Every
// step below only reads dependencies/browsers already present on disk:
//   - `pnpm install --frozen-lockfile` (installs deps) is a prerequisite,
//     run before this script, not by it.
//   - Playwright browsers are likewise a provisioned prerequisite
//     (`playwright install [--with-deps] chromium firefox`, run
//     once per machine/CI runner); `test:e2e` fails fast with a clear
//     error if they are missing rather than silently downloading them.
//   - `sbom` only reads the local dependency graph via `pnpm list`, which
//     does not contact a registry.
//   - `security:local` only does local file/pattern scanning. The
//     registry-backed dependency vulnerability audit lives in the
//     separate `pnpm run security:online` command.
const steps = [
  { label: "toolchain verification", command: "node", args: ["scripts/verify/check-toolchain.js"] },
  { label: "format:check", command: "pnpm", args: ["run", "format:check"] },
  { label: "lint", command: "pnpm", args: ["run", "lint"] },
  { label: "unit tests", command: "pnpm", args: ["run", "test:unit"] },
  { label: "contract tests", command: "pnpm", args: ["run", "test:contract"] },
  { label: "coverage", command: "pnpm", args: ["run", "test:coverage"] },
  { label: "build", command: "pnpm", args: ["run", "build"] },
  { label: "consumer tests", command: "pnpm", args: ["run", "test:consumer"] },
  { label: "playwright end-to-end tests", command: "pnpm", args: ["run", "test:e2e"] },
  {
    label: "SBOM (offline, from the local dependency graph)",
    command: "pnpm",
    args: ["run", "sbom"],
  },
  {
    label: "security scanner regression tests",
    command: "pnpm",
    args: ["run", "test:security"],
  },
  {
    label: "security:local (offline secret + bundle scan)",
    command: "pnpm",
    args: ["run", "security:local"],
  },
];

for (const step of steps) {
  console.log(`\n▶ verify: ${step.label}`);
  try {
    execFileSync(step.command, step.args, { cwd: repoRoot, stdio: "inherit" });
  } catch {
    console.error(`\n✖ verify FAILED at step: ${step.label}`);
    process.exit(1);
  }
}

console.log("\n✔ pnpm verify completed successfully.");
