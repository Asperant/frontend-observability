import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const steps = [
  { label: "toolchain verification", command: "node", args: ["scripts/verify/check-toolchain.js"] },
  { label: "format:check", command: "pnpm", args: ["run", "format:check"] },
  { label: "lint", command: "pnpm", args: ["run", "lint"] },
  { label: "unit tests", command: "pnpm", args: ["run", "test:unit"] },
  { label: "contract tests", command: "pnpm", args: ["run", "test:contract"] },
  { label: "coverage", command: "pnpm", args: ["run", "test:coverage"] },
  { label: "build", command: "pnpm", args: ["run", "build"] },
  { label: "consumer tests", command: "pnpm", args: ["run", "test:consumer"] },
  {
    label: "playwright browser install",
    command: "pnpm",
    args: ["exec", "playwright", "install", "chromium", "firefox", "webkit"],
  },
  { label: "playwright end-to-end tests", command: "pnpm", args: ["run", "test:e2e"] },
  { label: "security:local", command: "pnpm", args: ["run", "security:local"] },
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
