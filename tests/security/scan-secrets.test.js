// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { scanForSecrets } from "../../scripts/security/scan-secrets.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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

describe("scanForSecrets", () => {
  it("flags private key material", () => {
    const findings = writeAndScan(
      "leak.js",
      "const key = `-----BEGIN RSA PRIVATE KEY-----\\nMIIB...\\n-----END RSA PRIVATE KEY-----`;",
    );
    expect(findings.some((f) => f.rule.includes("private key"))).toBe(true);
  });

  it("flags Basic Auth embedded in a URL", () => {
    const findings = writeAndScan(
      "leak.js",
      'const endpoint = "https://admin:hunter2@telemetry.example.com/collect";',
    );
    expect(findings.some((f) => f.rule.includes("Basic Auth"))).toBe(true);
  });

  it("flags a hardcoded private IP address", () => {
    const findings = writeAndScan("leak.js", 'const host = "10.20.30.40";');
    expect(findings.some((f) => f.rule.includes("private/internal IP"))).toBe(true);
  });

  it("flags a .env-style KEY=VALUE line", () => {
    const findings = writeAndScan("leak.js", "API_SECRET_TOKEN=abcdef1234567890\n");
    expect(findings.some((f) => f.rule.includes(".env-style"))).toBe(true);
  });

  it("flags a credential-looking assignment", () => {
    const findings = writeAndScan(
      "leak.js",
      'const config = { adminPassword: "sup3rSecretValue123" };',
    );
    expect(findings.some((f) => f.rule.includes("credential-looking"))).toBe(true);
  });

  it("does not flag ordinary, secret-free source code", () => {
    const findings = writeAndScan(
      "clean.js",
      'export function add(a, b) {\n  return a + b;\n}\nconst localhost = "http://127.0.0.1:4311";\n',
    );
    expect(findings).toEqual([]);
  });

  it("does not descend into ignored directories such as node_modules", () => {
    workDir = mkdtempSync(join(tmpdir(), "chicek-secret-scan-"));
    const nodeModulesDir = join(workDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(
      join(nodeModulesDir, "leak.js"),
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----",
      "utf8",
    );
    expect(scanForSecrets([workDir])).toEqual([]);
  });
});

describe("the real repository source", () => {
  it("contains no secret-scan findings in apps/, packages/, or tests/", () => {
    const findings = scanForSecrets([
      join(repoRoot, "apps"),
      join(repoRoot, "packages"),
      join(repoRoot, "tests"),
    ]);
    expect(findings).toEqual([]);
  });
});
