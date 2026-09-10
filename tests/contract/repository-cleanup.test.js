import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("packages/privacy-policy stays removed", () => {
  it("the workspace directory no longer exists", () => {
    expect(existsSync(join(repoRoot, "packages/privacy-policy"))).toBe(false);
  });

  it("no workspace package.json depends on @frontend-observability/privacy-policy", () => {
    const roots = ["apps", "packages"];
    const offenders = [];
    for (const root of roots) {
      for (const entry of readdirSync(join(repoRoot, root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = join(repoRoot, root, entry.name, "package.json");
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["@frontend-observability/privacy-policy"]) offenders.push(pkgPath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the lockfile no longer references it", () => {
    const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).not.toMatch(/privacy-policy/);
  });
});

describe("CI does not install unused browser engines", () => {
  it("ci.yml installs only chromium and firefox, not webkit", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const installLine = workflow
      .split("\n")
      .find((line) => line.includes("playwright install --with-deps"));
    expect(installLine).toBeDefined();
    expect(installLine).not.toMatch(/webkit/);
  });

  it("no playwright config in the repo defines a webkit project", () => {
    const configFiles = readdirSync(repoRoot).filter(
      (name) => name.startsWith("playwright") && name.endsWith(".config.js"),
    );
    expect(configFiles.length).toBeGreaterThan(0);
    for (const name of configFiles) {
      const text = readFileSync(join(repoRoot, name), "utf8");
      const projectsBlock = text.split("projects:")[1] ?? "";
      expect(projectsBlock).not.toMatch(/name:\s*["']webkit["']/);
    }
  });
});
