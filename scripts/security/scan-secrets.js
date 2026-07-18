import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const SCAN_EXTENSIONS = new Set([".js", ".jsx", ".json", ".md", ".html", ".css", ".yml", ".yaml"]);

// "scripts" is excluded because scripts/security and scripts/build contain
// the literal regex/pattern text used for this scan and for the build gate;
// scanning them would trigger false positives against their own source.
// "security" excludes tests/security, whose fixtures intentionally contain
// planted fake secrets to verify this scanner detects them.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  "blob-report",
  ".pnpm-store",
  ".cache",
  ".tmp",
  "scripts",
  "security",
]);

const RULES = [
  { name: "private key material", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "credential-looking assignment (secret/token/password/admin)",
    pattern:
      /(secret|token|api[_-]?key|password|passwd|admin[_-]?(password|secret|token))\s*[:=]\s*["'][A-Za-z0-9/+_-]{12,}["']/i,
  },
  { name: "Basic Auth embedded in a URL", pattern: /https?:\/\/[^/\s:'"]+:[^/\s@'"]+@/ },
  { name: ".env-style KEY=VALUE line", pattern: /^[A-Z][A-Z0-9_]{3,}=\S+/m },
  {
    name: "hardcoded private/internal IP address",
    pattern:
      /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  { name: "JS source map reference", pattern: /sourceMappingURL\s*=/ },
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

export function scanForSecrets(roots = [repoRoot]) {
  const findings = [];

  for (const root of roots) {
    let files;
    try {
      files = walk(root);
    } catch {
      continue;
    }

    for (const filePath of files) {
      const content = readFileSync(filePath, "utf8");
      for (const rule of RULES) {
        if (rule.pattern.test(content)) {
          findings.push({ file: filePath.replace(`${repoRoot}`, ""), rule: rule.name });
        }
      }
    }
  }

  return findings;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const findings = scanForSecrets([repoRoot]);
  if (findings.length > 0) {
    console.error("Secret scan FAILED. Findings:");
    for (const finding of findings) {
      console.error(`  - [${finding.rule}] ${finding.file}`);
    }
    process.exit(1);
  }
  console.log("Secret scan passed: no forbidden patterns found.");
}
