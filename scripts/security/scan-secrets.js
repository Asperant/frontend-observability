import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Directory names that are always build output, dependency trees, VCS
// internals, or runtime-only state -- never product, test, or doc source.
// Safe to exclude at any depth (mirrors the equivalent non-anchored
// patterns in .gitignore). This list must never contain a real source
// directory name such as "scripts" or "security" -- doing that previously
// hid scripts/lab/ and tests/security/ from every scan.
const IGNORED_DIR_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".runtime",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  "blob-report",
  "reports",
  ".pnpm-store",
  ".cache",
  ".tmp",
]);

// Extensions that are binary and must never be read as UTF-8 text, even if
// git happens to track one. Certificates/keys are intentionally NOT listed
// here: PEM material is plain text, and it's exactly what the "private key
// material" rule below exists to catch if one is ever committed.
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".zip",
  ".gz",
  ".tgz",
  ".pdf",
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
  {
    // Excludes RHS values that are shell parameter/command expansions
    // (`$VAR`, `${VAR}`, `$(cmd)`, optionally quoted) -- those read a
    // secret from a file/env at runtime rather than embedding one, which
    // is exactly the pattern this repo's entrypoint scripts use on
    // purpose. A literal hardcoded value, quoted or not, still matches.
    name: ".env-style KEY=VALUE line",
    pattern: /^[A-Z][A-Z0-9_]{3,}=(?!"?\$)\S+/m,
  },
  {
    name: "hardcoded private/internal IP address",
    pattern:
      /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  { name: "JS source map reference", pattern: /sourceMappingURL\s*=/ },
];

function isIgnoredRelativePath(relPath) {
  return relPath.split(sep).some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIR_SEGMENTS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (!BINARY_EXTENSIONS.has(extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanContent(content) {
  const matches = [];
  for (const rule of RULES) {
    if (rule.pattern.test(content)) matches.push(rule.name);
  }
  return matches;
}

function readTextOrNull(absPath) {
  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return null; // unreadable (e.g. genuinely binary); skip rather than crash the gate
  }
  if (content.includes("\u0000")) return null; // binary heuristic
  return content;
}

// Walks an arbitrary directory tree on disk (not git-aware). Used for
// scanning locations that are never git-tracked source -- build output
// (dist/), and isolated temp-directory fixtures in tests.
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
      const content = readTextOrNull(filePath);
      if (content === null) continue;
      for (const ruleName of scanContent(content)) {
        findings.push({ file: filePath.replace(repoRoot, ""), rule: ruleName });
      }
    }
  }

  return findings;
}

// Scans every file Git actually tracks in `repoDir`. This is the
// authoritative "real repository" scan: it automatically excludes
// anything covered by .gitignore (node_modules/, dist/, coverage/,
// .runtime/, reports/, test-results/, playwright-report/, etc.) without a
// hand-maintained directory list, so it can never silently skip a tracked
// source directory the way a basename-based ignore list did before. The
// IGNORED_DIR_SEGMENTS / BINARY_EXTENSIONS checks below are defense in
// depth only, for the hypothetical case something ends up tracked anyway.
export function scanTrackedFiles(repoDir = repoRoot) {
  const trackedOutput = execFileSync("git", ["-C", repoDir, "ls-files", "-z"], {
    encoding: "utf8",
  });
  const trackedRelPaths = trackedOutput.split("\u0000").filter(Boolean);

  const findings = [];
  for (const relPath of trackedRelPaths) {
    if (BINARY_EXTENSIONS.has(extname(relPath))) continue;
    if (isIgnoredRelativePath(relPath)) continue;

    const content = readTextOrNull(join(repoDir, relPath));
    if (content === null) continue;
    for (const ruleName of scanContent(content)) {
      findings.push({ file: relPath, rule: ruleName });
    }
  }

  return findings;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const findings = scanTrackedFiles(repoRoot);
  if (findings.length > 0) {
    console.error("Secret scan FAILED. Findings:");
    for (const finding of findings) {
      console.error(`  - [${finding.rule}] ${finding.file}`);
    }
    process.exit(1);
  }
  console.log("Secret scan passed: no forbidden patterns found.");
}
