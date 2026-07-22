import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  caCertPath,
  caKeyPath,
  certsDir,
  fileMode,
  isWorldOrGroupReadableSecret,
  leafCertPath,
  leafKeyPath,
  rejectSymlink,
  run,
  tlsLeafDir,
} from "./common.mjs";

const CA_DAYS = 3650;
const LEAF_DAYS = 397;
const RENEWAL_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // renew if <14 days remain

export function readCertificate(path) {
  return new X509Certificate(readFileSync(path));
}

export function certExpiresSoon(path) {
  if (!existsSync(path)) return true;
  const cert = readCertificate(path);
  const validTo = new Date(cert.validTo).getTime();
  return validTo - Date.now() < RENEWAL_THRESHOLD_MS;
}

export function certHasExpectedSan(path) {
  const cert = readCertificate(path);
  return cert.checkHost("localhost") !== undefined && cert.checkIP("127.0.0.1") !== undefined;
}

function assertKeyIsSafe(path) {
  rejectSymlink(path);
  if (isWorldOrGroupReadableSecret(path)) {
    throw new Error(`refusing to reuse world/group-readable private key: ${path}`);
  }
}

function openssl(args, cwd) {
  const result = run("openssl", args, { capture: true, allowFailure: true, cwd });
  if (result.status !== 0) {
    throw new Error(`openssl ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function moveIntoPlace(tempPath, finalPath, mode) {
  rejectSymlink(finalPath);
  renameSync(tempPath, finalPath);
  run("chmod", [mode, finalPath], { allowFailure: false });
}

/**
 * Idempotent: a CA/leaf pair that is still valid (correct SAN, not expiring
 * soon) is left untouched. Generates a fresh local-only CA and a
 * localhost/127.0.0.1 leaf certificate signed by it, with no sudo and no
 * system trust store changes.
 *
 * `force: true` (used by the TLS rotation test/tool) skips the "still
 * valid, leave it alone" short-circuit for the leaf cert specifically —
 * real periodic rotation only ever replaces the short-lived leaf, signed by
 * the existing long-lived CA, so `force` never touches the CA.
 */
export function ensureCertificates({ force = false } = {}) {
  mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  mkdirSync(tlsLeafDir, { recursive: true, mode: 0o700 });

  const caValid = existsSync(caCertPath) && existsSync(caKeyPath) && !certExpiresSoon(caCertPath);
  const leafValid =
    !force &&
    existsSync(leafCertPath) &&
    existsSync(leafKeyPath) &&
    !certExpiresSoon(leafCertPath) &&
    certHasExpectedSan(leafCertPath);

  if (caValid) assertKeyIsSafe(caKeyPath);
  if (leafValid) assertKeyIsSafe(leafKeyPath);

  if (caValid && leafValid) {
    return { caCreated: false, leafCreated: false };
  }

  const scratch = mkdtempSync(join(tmpdir(), "chicek-lab-certs-"));
  try {
    const needsCa = !caValid;
    if (needsCa) {
      openssl(
        ["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", "lab-ca.key"],
        scratch,
      );
      openssl(
        [
          "req",
          "-x509",
          "-new",
          "-key",
          "lab-ca.key",
          "-sha256",
          "-days",
          String(CA_DAYS),
          "-out",
          "lab-ca.crt",
          "-subj",
          "/CN=Chicek Lab Local CA",
          "-addext",
          "basicConstraints=critical,CA:true",
          "-addext",
          "keyUsage=critical,keyCertSign,cRLSign",
        ],
        scratch,
      );
      moveIntoPlace(join(scratch, "lab-ca.key"), caKeyPath, "600");
      moveIntoPlace(join(scratch, "lab-ca.crt"), caCertPath, "644");
    }

    openssl(
      ["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", "localhost.key"],
      scratch,
    );
    openssl(
      ["req", "-new", "-key", "localhost.key", "-out", "localhost.csr", "-subj", "/CN=localhost"],
      scratch,
    );
    const extFile = join(scratch, "localhost.ext");
    run(
      "sh",
      [
        "-c",
        `printf 'basicConstraints=CA:FALSE\\nkeyUsage=digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\nsubjectAltName=DNS:localhost,IP:127.0.0.1\\n' > ${JSON.stringify(extFile)}`,
      ],
      { allowFailure: false, cwd: scratch },
    );
    openssl(
      [
        "x509",
        "-req",
        "-in",
        "localhost.csr",
        "-CA",
        caCertPath,
        "-CAkey",
        caKeyPath,
        "-CAcreateserial",
        "-CAserial",
        join(scratch, "lab-ca.srl"),
        "-out",
        "localhost.crt",
        "-days",
        String(LEAF_DAYS),
        "-sha256",
        "-extfile",
        extFile,
      ],
      scratch,
    );
    moveIntoPlace(join(scratch, "localhost.key"), leafKeyPath, "600");
    moveIntoPlace(join(scratch, "localhost.crt"), leafCertPath, "644");

    return { caCreated: needsCa, leafCreated: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function certPermissionsOk() {
  return (
    fileMode(caKeyPath) === 0o600 &&
    fileMode(leafKeyPath) === 0o600 &&
    fileMode(caCertPath) === 0o644 &&
    fileMode(leafCertPath) === 0o644
  );
}
