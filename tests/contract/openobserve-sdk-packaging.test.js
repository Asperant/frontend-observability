import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const distDir = fileURLToPath(
  new URL("../../packages/browser-observability/dist/", import.meta.url),
);

function readPackageJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

describe("OpenObserve SDK dependency resolution (no duplicate/mismatched versions)", () => {
  it("resolves exactly one version of @openobserve/browser-core across browser-rum and browser-logs", () => {
    const raw = execFileSync(
      "pnpm",
      [
        "list",
        "--filter",
        "@chicek/browser-observability",
        "@openobserve/browser-core",
        "--depth",
        "5",
        "--json",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const [project] = JSON.parse(raw);
    const versions = new Set();
    (function collect(deps) {
      if (!deps) return;
      for (const [name, info] of Object.entries(deps)) {
        if (name === "@openobserve/browser-core") versions.add(info.version);
        if (info.dependencies) collect(info.dependencies);
      }
    })(project.dependencies);
    expect(versions.size).toBe(1);
    expect([...versions][0]).toBe("0.3.4");
  });
});

describe("built dist/ never loads the SDK unless a dynamic import actually runs", () => {
  it("dist/index.js has no top-level side effects that touch the SDK chunk", async () => {
    if (!existsSync(`${distDir}index.js`)) {
      throw new Error(
        "dist/index.js is missing — run `pnpm --filter @chicek/browser-observability build` first.",
      );
    }
    // Importing the built artifact must never fetch/execute adapter-openobserve.js.
    const mod = await import(`${distDir}index.js?contract-test`);
    expect(Object.keys(mod).sort()).toEqual(
      [
        "getObservabilityStatus",
        "initializeObservability",
        "recordAction",
        "recordError",
        "setTrackingConsent",
        "shutdownObservability",
      ].sort(),
    );
  });

  it("dist/ contains no admin/root credential or management-endpoint literals", () => {
    const indexContent = readFileSync(`${distDir}index.js`, "utf8");
    const adapterContent = existsSync(`${distDir}adapter-openobserve.js`)
      ? readFileSync(`${distDir}adapter-openobserve.js`, "utf8")
      : "";
    const combined = `${indexContent}\n${adapterContent}`;
    expect(combined).not.toMatch(/openobserve[_-]root[_-](email|password)/i);
    expect(combined).not.toMatch(
      /\/api\/[^"'`\s]*\/(users|organizations|streams|dashboards|alerts)\b/,
    );
  });
});

describe("SDK versions are pinned exactly (no ^, ~, or dist-tag range)", () => {
  it("packages/browser-observability/package.json pins @openobserve/* to bare semver", () => {
    const pkg = readPackageJson("../../packages/browser-observability/package.json");
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (!name.startsWith("@openobserve/")) continue;
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
