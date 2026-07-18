import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  certExpiresSoon,
  certHasExpectedSan,
  readCertificate,
} from "../../scripts/lab/generate-certs.mjs";

let scratchDir;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "chicek-lab-cert-metadata-"));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function makeCert({ days, sanExtra = "" }) {
  const keyPath = join(scratchDir, "key.pem");
  const certPath = join(scratchDir, "cert.pem");
  execFileSync("openssl", ["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath]);
  execFileSync("openssl", [
    "req",
    "-x509",
    "-new",
    "-key",
    keyPath,
    "-sha256",
    "-days",
    String(days),
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-addext",
    `subjectAltName=DNS:localhost,IP:127.0.0.1${sanExtra}`,
  ]);
  return certPath;
}

describe("readCertificate / certHasExpectedSan", () => {
  it("recognizes a certificate with the correct localhost/127.0.0.1 SAN", () => {
    const certPath = makeCert({ days: 30 });
    expect(certHasExpectedSan(certPath)).toBe(true);
    const cert = readCertificate(certPath);
    expect(cert.subject).toContain("CN=localhost");
  });

  it("rejects a certificate missing the expected SAN", () => {
    const keyPath = join(scratchDir, "key2.pem");
    const certPath = join(scratchDir, "cert2.pem");
    execFileSync("openssl", [
      "ecparam",
      "-genkey",
      "-name",
      "prime256v1",
      "-noout",
      "-out",
      keyPath,
    ]);
    execFileSync("openssl", [
      "req",
      "-x509",
      "-new",
      "-key",
      keyPath,
      "-sha256",
      "-days",
      "30",
      "-out",
      certPath,
      "-subj",
      "/CN=example.invalid",
      "-addext",
      "subjectAltName=DNS:example.invalid",
    ]);
    expect(certHasExpectedSan(certPath)).toBe(false);
  });
});

describe("certExpiresSoon", () => {
  it("is true for a missing file", () => {
    expect(certExpiresSoon(join(scratchDir, "does-not-exist.pem"))).toBe(true);
  });

  it("is true for a certificate that expires within the renewal threshold", () => {
    const certPath = makeCert({ days: 1 });
    expect(certExpiresSoon(certPath)).toBe(true);
  });

  it("is false for a certificate with plenty of remaining validity", () => {
    const certPath = makeCert({ days: 365 });
    expect(certExpiresSoon(certPath)).toBe(false);
  });
});
