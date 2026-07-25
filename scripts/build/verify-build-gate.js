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

// The OpenObserve RUM/Logs SDK is only ever reachable through a dynamic
// import() (see src/adapter/openobserve/load-sdk.js), so Vite/Rollup code-
// splits it into its own chunk instead of folding it into index.js. That
// chunk has one fixed, non-content-hashed filename (see vite.config.js's
// manualChunks/chunkFileNames) so this gate can allowlist it by exact name
// across rebuilds instead of pattern-matching a hash.
const ALLOWED_FILES = new Set(["index.js", "adapter-openobserve.js", "artifact-manifest.json"]);

const FORBIDDEN_CONTENT_PATTERNS = [
  { name: "source map reference", pattern: /sourceMappingURL/ },
  { name: "React runtime", pattern: /\breact(-dom)?\b/i },
  // (?<!document\.) excludes the vendor SDK's legitimate
  // `document.createElement("iframe")` DOM-feature-detection call — this is
  // about catching React JSX output, not any createElement call at all.
  {
    name: "JSX pragma / dev runtime",
    pattern: /jsx-runtime|_jsxDEV|(?<!document\.)createElement\(/,
  },
  {
    name: "HTTP test service fixture reference",
    pattern: /http-test-service-fixture|127\.0\.0\.1:4311/i,
  },
  // OpenObserve/RUM management-plane surface (search, users, orgs, streams,
  // dashboards, alerts, source maps) must never be reachable from the
  // browser bundle — only the ingestion paths the adapter itself calls.
  { name: "management/admin endpoint path", pattern: /\/(admin|management)\// },
  {
    name: "OpenObserve management API path",
    pattern: /\/api\/[^"'`\s]*\/(users|organizations|streams|dashboards|alerts|prometheus|otlp)\b/,
  },
  { name: ".env-style content line", pattern: /^[A-Z][A-Z0-9_]{3,}=\S+/m },
  { name: "private key material", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "Basic Auth embedded in a URL", pattern: /https?:\/\/[^/\s:'"]+:[^/\s@'"]+@/ },
  {
    name: "root/admin credential secret path",
    pattern: /openobserve[_-]root[_-](email|password)/i,
  },
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

if (!entries.includes("adapter-openobserve.js")) {
  errors.push(
    "dist/adapter-openobserve.js is missing: the OpenObserve SDK dynamic-import chunk must exist.",
  );
}

for (const jsFile of ["index.js", "adapter-openobserve.js"]) {
  if (!entries.includes(jsFile)) continue;
  const filePath = join(distDir, jsFile);
  const content = readFileSync(filePath, "utf8");
  for (const { name, pattern } of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(`dist/${jsFile} contains forbidden content: ${name}`);
    }
  }
}

if (entries.includes("index.js")) {
  const indexPath = join(distDir, "index.js");
  const content = readFileSync(indexPath, "utf8");

  if (!/import\(\s*["'`]\.\/adapter-openobserve\.js["'`]\s*\)/.test(content)) {
    errors.push(
      "dist/index.js must load dist/adapter-openobserve.js only via a dynamic import() " +
        "(no static import was found referencing it).",
    );
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
