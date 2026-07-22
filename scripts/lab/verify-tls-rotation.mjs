// Stage 20 closeout: proves TLS cert rotation actually takes effect on
// `nginx -s reload` alone, with no reverse-proxy container recreate — the
// real regression this guards is the single-file bind-mount inode-pinning
// hazard documented in scripts/lab/common.mjs's tlsLeafDir comment (the same
// class of bug Stage 14 fixed for the kill switch's proxy-dynamic mount,
// applied here to infrastructure/docker/compose.yaml's tls-leaf mount).
import { connect as tlsConnect } from "node:tls";

import { leafCertPath, log, logError } from "./common.mjs";
import { ensureCertificates, readCertificate } from "./generate-certs.mjs";
import { reloadReverseProxy, waitForReloadSettle } from "./proxy-gate.mjs";
import { requestHttps } from "./verify-http.mjs";

function servedFingerprint() {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: "127.0.0.1",
        port: 8443,
        servername: "localhost",
        rejectUnauthorized: false,
        timeout: 8000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.fingerprint256) {
          reject(new Error("no peer certificate returned by reverse-proxy"));
          return;
        }
        resolve(cert.fingerprint256);
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => socket.destroy(new Error("TLS connection timed out")));
  });
}

export async function verifyTlsRotation() {
  const findings = [];

  const beforeDiskFingerprint = readCertificate(leafCertPath).fingerprint256;
  const beforeServedFingerprint = await servedFingerprint();
  if (beforeServedFingerprint !== beforeDiskFingerprint) {
    findings.push(
      "precondition failed: certificate currently served does not match the certificate on disk " +
        "(cannot attribute a later mismatch to rotation).",
    );
  }

  const rotation = ensureCertificates({ force: true });
  if (!rotation.leafCreated) {
    findings.push("ensureCertificates({ force: true }) did not report a new leaf certificate.");
  }
  const afterDiskFingerprint = readCertificate(leafCertPath).fingerprint256;
  if (afterDiskFingerprint === beforeDiskFingerprint) {
    findings.push("rotated leaf certificate has the same fingerprint as before (not rotated).");
  }

  reloadReverseProxy();

  // `nginx -s reload` gracefully drains old workers rather than cutting
  // them instantly (see proxy-gate.mjs's waitForReloadSettle doc), so the
  // very next connection can still legitimately land on an old worker mid-
  // shutdown. Poll with a bounded timeout instead of asserting immediately
  // — a *permanently* stale fingerprint (the inode-pinning regression this
  // test guards against) is what must fail, not a settle race.
  let afterServedFingerprint = await servedFingerprint();
  const pollDeadline = Date.now() + 10_000;
  while (afterServedFingerprint !== afterDiskFingerprint && Date.now() < pollDeadline) {
    await waitForReloadSettle(500);
    afterServedFingerprint = await servedFingerprint();
  }

  if (afterServedFingerprint === beforeServedFingerprint) {
    findings.push(
      "reverse-proxy is still serving the pre-rotation certificate fingerprint 10s after " +
        "`nginx -s reload` — stale single-file bind-mount inode pinning has regressed.",
    );
  } else if (afterServedFingerprint !== afterDiskFingerprint) {
    findings.push(
      "reverse-proxy is serving a certificate fingerprint that matches neither the old nor the " +
        "newly rotated on-disk certificate.",
    );
  }

  // The rotated cert is still signed by the same trusted lab CA and the
  // hostname/SAN contract is unchanged, so a real (non-skipped) TLS chain
  // validation against our CA must keep succeeding post-rotation.
  const chainCheck = await requestHttps("/healthz");
  if (chainCheck.statusCode !== 200) {
    findings.push(
      `CA-validated HTTPS request after rotation failed: GET /healthz returned ${chainCheck.statusCode}.`,
    );
  }

  return {
    pass: findings.length === 0,
    findings,
    beforeFingerprint: beforeDiskFingerprint,
    afterFingerprint: afterDiskFingerprint,
  };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    const result = await verifyTlsRotation();
    if (!result.pass) {
      for (const finding of result.findings) logError(`  - ${finding}`);
      logError("verify-tls-rotation FAILED");
      process.exit(1);
    }
    log(
      `verify-tls-rotation PASSED (before=${result.beforeFingerprint} after=${result.afterFingerprint})`,
    );
  } catch (error) {
    logError(`verify-tls-rotation FAILED: ${error.message}`);
    process.exit(1);
  }
}
