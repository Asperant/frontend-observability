import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const distDir = join(repoRoot, "packages/browser-observability/dist");

const EXPECTED_PUBLIC_EXPORTS = [
  "getObservabilityStatus",
  "initializeObservability",
  "recordAction",
  "recordError",
  "setTrackingConsent",
  "shutdownObservability",
].sort();

const ALLOWED_FILES = new Set(["index.js", "artifact-manifest.json"]);

const FORBIDDEN_CONTENT_PATTERNS = [
  { name: "source map reference", pattern: /sourceMappingURL/ },
  { name: "React runtime", pattern: /\breact(-dom)?\b/i },
  { name: "JSX pragma / dev runtime", pattern: /jsx-runtime|_jsxDEV|createElement\(/ },
  { name: "mock API reference", pattern: /mock-api|127\.0\.0\.1:4311/i },
  { name: "management/admin endpoint path", pattern: /\/(admin|management)\// },
  { name: ".env-style content line", pattern: /^[A-Z][A-Z0-9_]{3,}=\S+/m },
  { name: "private key material", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "Basic Auth embedded in a URL", pattern: /https?:\/\/[^/\s:'"]+:[^/\s@'"]+@/ },
];

const errors = [];

let entries;
try {
  entries = readdirSync(distDir);
} catch {
  entries = [];
  errors.push(`dist directory not found at ${distDir}. Run the build first.`);
}

for (const entry of entries) {
  if (!ALLOWED_FILES.has(entry)) {
    errors.push(`Unexpected file in packages/browser-observability/dist/: ${entry}`);
  }
  if (entry.endsWith(".map")) {
    errors.push(`Source map found in packages/browser-observability/dist/: ${entry}`);
  }
}

if (entries.includes("index.js")) {
  const indexPath = join(distDir, "index.js");
  const content = readFileSync(indexPath, "utf8");

  for (const { name, pattern } of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(`dist/index.js contains forbidden content: ${name}`);
    }
  }

  const moduleExports = await import(pathToFileURL(indexPath).href);
  const actualExports = Object.keys(moduleExports).sort();

  if (JSON.stringify(actualExports) !== JSON.stringify(EXPECTED_PUBLIC_EXPORTS)) {
    errors.push(
      `dist/index.js public exports do not match the approved API. ` +
        `expected=[${EXPECTED_PUBLIC_EXPORTS.join(", ")}] actual=[${actualExports.join(", ")}]`,
    );
  }
}

if (errors.length > 0) {
  console.error("Build security gate FAILED:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log("Build security gate passed: dist/ contains only the approved public artifact.");
