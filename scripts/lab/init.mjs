import { certPermissionsOk, ensureCertificates } from "./generate-certs.mjs";
import { ensureSecrets } from "./generate-secrets.mjs";
import { generateRuntimeConfig } from "./generate-runtime-config.mjs";
import { assertExactLabToolchain, log } from "./common.mjs";

export function labInit() {
  log("lab:init — ensuring runtime secrets, TLS certificates, and runtime config...");

  const secretResult = ensureSecrets();
  log(
    `  secrets: email ${secretResult.emailCreated ? "generated" : "reused"}, ` +
      `password ${secretResult.passwordCreated ? "generated" : "reused"} (0600, values never printed)`,
  );

  const certResult = ensureCertificates();
  if (!certPermissionsOk()) {
    throw new Error("generated certificate/key files do not have the expected permissions.");
  }
  log(
    `  certs: CA ${certResult.caCreated ? "generated" : "reused"}, ` +
      `leaf ${certResult.leafCreated ? "generated" : "reused"} (DNS:localhost, IP:127.0.0.1)`,
  );

  generateRuntimeConfig();
  log("  runtime config: written to .runtime/generated/runtime-config.json (enabled=false)");

  log("lab:init complete.");
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:init");
    labInit();
  } catch (error) {
    process.stderr.write(`lab:init FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
