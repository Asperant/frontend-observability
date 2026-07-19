// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { scanForSecrets, scanTrackedFiles } from "../../scripts/security/scan-secrets.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Every fixture below that is secret-shaped is assembled from separate
// string-literal fragments (never one contiguous literal) instead of being
// written as a single matchable string. Now that tests/security/** is
// itself part of the real-repository scan (see the "real repository
// source" describe block), a plain contiguous fixture literal would make
// this file flag itself: the scanner reads raw file text, so any
// PEM-header-shaped, credential-shaped, or IP-shaped run of characters
// sitting in this file's own source is just as visible to it as one in
// application code. Splitting each fixture across a `+` keeps the
// *scanned file content* (built at runtime) fully secret-shaped while
// keeping *this file's own source text* non-contiguous and therefore
// non-matching. Do not paste a contiguous example into a comment either --
// that is exactly as scannable as code.
let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeAndScan(fileName, content) {
  workDir = mkdtempSync(join(tmpdir(), "chicek-secret-scan-"));
  writeFileSync(join(workDir, fileName), content, "utf8");
  return scanForSecrets([workDir]);
}

describe("scanForSecrets (arbitrary directory walk)", () => {
  it("flags private key material", () => {
    const beginMarker = "-----BEGIN" + " RSA PRIVATE KEY-----";
    const findings = writeAndScan(
      "leak.js",
      `const key = \`${beginMarker}\\nMIIB...\\n-----END RSA PRIVATE KEY-----\`;`,
    );
    expect(findings.some((f) => f.rule.includes("private key"))).toBe(true);
  });

  it("flags Basic Auth embedded in a URL", () => {
    const endpoint = "https://admin:" + "hunter2@telemetry.example.com/collect";
    const findings = writeAndScan("leak.js", `const endpoint = "${endpoint}";`);
    expect(findings.some((f) => f.rule.includes("Basic Auth"))).toBe(true);
  });

  it("flags a hardcoded private IP address", () => {
    const ip = "10.20.30" + ".40";
    const findings = writeAndScan("leak.js", `const host = "${ip}";`);
    expect(findings.some((f) => f.rule.includes("private/internal IP"))).toBe(true);
  });

  it("flags a .env-style KEY=VALUE line with a literal value", () => {
    const line = "API_SECRET" + "_TOKEN=abcdef1234567890";
    const findings = writeAndScan("leak.js", `${line}\n`);
    expect(findings.some((f) => f.rule.includes(".env-style"))).toBe(true);
  });

  it("does not flag a .env-style line whose value is a shell expansion", () => {
    const commandSub = "TOKEN" + '="$(cat "$token_file")"';
    const varRef = "OTHER" + '="${SOME_VAR}"';
    const findings = writeAndScan("entrypoint.sh", `${commandSub}\n${varRef}\n`);
    expect(findings.some((f) => f.rule.includes(".env-style"))).toBe(false);
  });

  it("flags a credential-looking assignment", () => {
    const value = "sup3rSecretValue" + "123";
    const findings = writeAndScan("leak.js", `const config = { adminPassword: "${value}" };`);
    expect(findings.some((f) => f.rule.includes("credential-looking"))).toBe(true);
  });

  it("does not flag ordinary, secret-free source code", () => {
    const findings = writeAndScan(
      "clean.js",
      'export function add(a, b) {\n  return a + b;\n}\nconst localhost = "http://127.0.0.1:4311";\n',
    );
    expect(findings).toEqual([]);
  });

  it("does not flag a short placeholder value below the length threshold", () => {
    const findings = writeAndScan("leak.js", 'const apiKey = "changeme";\n');
    expect(findings).toEqual([]);
  });

  it("does not descend into ignored directories such as node_modules", () => {
    workDir = mkdtempSync(join(tmpdir(), "chicek-secret-scan-"));
    const nodeModulesDir = join(workDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
    const beginMarker = "-----BEGIN" + " RSA PRIVATE KEY-----";
    writeFileSync(
      join(nodeModulesDir, "leak.js"),
      `${beginMarker}\nMIIB...\n-----END RSA PRIVATE KEY-----`,
      "utf8",
    );
    expect(scanForSecrets([workDir])).toEqual([]);
  });
});

// A single fake credential line, reused by every path-coverage test below.
// Built the same fragment-concatenation way as the fixtures above, for the
// same self-scan-avoidance reason. It is a placeholder value, never a real
// token, credential, or key.
function buildFakeCredentialLine() {
  return "admin" + "_token" + ':"' + "not-a-real-secret-canary-value-000" + '"';
}

function initTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "chicek-secret-scan-tracked-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "scanner-test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Scanner Test"], { cwd: dir });
  return dir;
}

describe("scanTrackedFiles (git-ls-files backed, what security:local actually runs)", () => {
  let repoDir;

  afterEach(() => {
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
      repoDir = undefined;
    }
  });

  // These mirror every top-level area Section 2 of the pre-Stage-15 audit
  // remediation requires coverage for. Before this fix, "scripts" and
  // "security" were excluded from every scan by directory basename, which
  // silently hid scripts/lab/ (token/kill-switch generation) and
  // tests/security/ (this file) from ever being scanned.
  const CANDIDATE_PATHS = [
    "scripts/lab/fake-secret.mjs",
    "infrastructure/reverse-proxy/fake-secret.conf",
    "docs/fake-secret.md",
    "fake-secret-at-root.yml",
    "apps/demo/fake-secret.js",
    "packages/browser-observability/fake-secret.js",
    "tests/unit/fake-secret.test.js",
  ];

  it.each(CANDIDATE_PATHS)("detects a fake committed secret at %s", (relPath) => {
    repoDir = initTempGitRepo();
    const absPath = join(repoDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, `${buildFakeCredentialLine()}\n`, "utf8");
    execFileSync("git", ["add", relPath], { cwd: repoDir });

    const findings = scanTrackedFiles(repoDir);

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(relPath);
    expect(findings[0].rule).toContain("credential-looking");
  });

  it("does not scan a file that exists on disk but was never git-added", () => {
    repoDir = initTempGitRepo();
    writeFileSync(join(repoDir, "untracked.js"), `${buildFakeCredentialLine()}\n`, "utf8");
    // deliberately never `git add`-ed

    expect(scanTrackedFiles(repoDir)).toEqual([]);
  });

  it("does not scan .runtime/ or node_modules/ even if force-committed", () => {
    repoDir = initTempGitRepo();
    for (const relPath of [".runtime/secrets/fake-secret.txt", "node_modules/pkg/fake-secret.js"]) {
      const absPath = join(repoDir, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, `${buildFakeCredentialLine()}\n`, "utf8");
    }
    // Force-add so git tracks them despite this throwaway repo having no
    // .gitignore of its own -- this proves the scanner's own
    // IGNORED_DIR_SEGMENTS defense-in-depth check, not just reliance on
    // .gitignore already having kept them untracked in the real repo.
    execFileSync("git", ["add", "-f", ".runtime/secrets/fake-secret.txt"], { cwd: repoDir });
    execFileSync("git", ["add", "-f", "node_modules/pkg/fake-secret.js"], { cwd: repoDir });

    expect(scanTrackedFiles(repoDir)).toEqual([]);
  });

  it("does not report its own canary as a finding when the fixture file is absent", () => {
    // Sanity check that buildFakeCredentialLine() only becomes secret-shaped
    // once written to a file and scanned -- not simply by being referenced
    // in this test file's own source, which is itself part of a real scan.
    repoDir = initTempGitRepo();
    writeFileSync(join(repoDir, "clean.js"), "export const ok = true;\n", "utf8");
    execFileSync("git", ["add", "clean.js"], { cwd: repoDir });

    expect(scanTrackedFiles(repoDir)).toEqual([]);
  });
});

describe("the real repository source", () => {
  it("contains no secret-scan findings across every tracked file", () => {
    // Deliberately not scoped to a subset of directories: scanTrackedFiles
    // follows `git ls-files`, so this exercises apps/, packages/, scripts/,
    // infrastructure/, tests/, docs/, and root tracked files in one call --
    // exactly the coverage the pre-Stage-15 audit found missing.
    const findings = scanTrackedFiles(repoRoot);
    expect(findings).toEqual([]);
  });
});
