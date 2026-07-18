import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function collectComponents(dependencyTree, components, seen) {
  if (!dependencyTree) return;
  for (const [name, info] of Object.entries(dependencyTree)) {
    if (!info || !info.version) continue;
    // Workspace-linked packages (version starts with "link:") are internal
    // components, not external supply-chain dependencies; the SBOM tracks
    // only third-party packages actually fetched from the registry.
    if (info.version.startsWith("link:")) {
      if (info.dependencies) collectComponents(info.dependencies, components, seen);
      continue;
    }
    const key = `${name}@${info.version}`;
    if (!seen.has(key)) {
      seen.add(key);
      const purlName = name.startsWith("@") ? name.replace("/", "%2F") : name;
      components.push({
        type: "library",
        name,
        version: info.version,
        purl: `pkg:npm/${purlName}@${info.version}`,
      });
    }
    if (info.dependencies) {
      collectComponents(info.dependencies, components, seen);
    }
  }
}

const raw = execFileSync("pnpm", ["list", "-r", "--json", "--prod", "--depth", "Infinity"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 32,
});

const projects = JSON.parse(raw);
const components = [];
const seen = new Set();

for (const project of projects) {
  collectComponents(project.dependencies, components, seen);
}

components.sort((a, b) => a.name.localeCompare(b.name));

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: "nodejs.org", name: "node", version: process.version.replace(/^v/, "") }],
    component: {
      type: "application",
      name: "chicek-frontend-observability",
    },
  },
  components,
};

const outDir = join(repoRoot, "reports");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "sbom.cyclonedx.json");
writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`);

console.log(
  `Wrote SBOM with ${components.length} production component(s) to ${outPath.replace(repoRoot, "")}`,
);
