import { certPermissionsOk, ensureCertificates } from "./generate-certs.mjs";
import { ensureSecrets } from "./generate-secrets.mjs";
import { generateRuntimeConfig } from "./generate-runtime-config.mjs";
import { generateRuntimeControl } from "./generate-runtime-control.mjs";
import { writeProxyGate } from "./proxy-gate.mjs";
import { assertExactLabToolchain, log } from "./common.mjs";

export function labInit() {
  log("lab:init — ensuring runtime secrets, TLS certificates, and runtime config...");

  const secretResult = ensureSecrets();
  log(
    `  secrets: email ${secretResult.emailCreated ? "generated" : "reused"}, ` +
      `password ${secretResult.passwordCreated ? "generated" : "reused"}, ` +
      `RUM client token ${secretResult.rumClientTokenCreated ? "generated" : "reused"} ` +
      `(0600, values never printed)`,
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
  log("  runtime config: written to .runtime/generated/runtime-config.json (enabled=true)");

  // Kill switch starts fully open: a normal, inactive control document and
  // an open proxy gate. The reverse-proxy container is not running yet at
  // lab:init time, so this only writes the bind-mounted files it will read
  // on its very first start — no reload is needed (or possible) here.
  const controlDocument = generateRuntimeControl({
    killSwitch: { active: false, reasonCode: "none" },
  });
  writeProxyGate(false);
  log(
    `  runtime control: written to .runtime/generated/runtime-control.json ` +
      `(revision=${controlDocument.revision}, killSwitch inactive); proxy gate open`,
  );

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
