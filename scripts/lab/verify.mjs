import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { runAllStaticChecks } from "./static-checks.mjs";
import { checkSecretSecurity } from "./verify-secrets.mjs";
import { checkTlsAndProxy } from "./verify-tls-proxy.mjs";
import { checkContainerSecurity } from "./verify-containers.mjs";
import { checkPersistence } from "./verify-persistence.mjs";
import { checkFailureIsolation } from "./verify-failure-isolation.mjs";
import { waitForHealthy } from "./wait.mjs";

const PHASES = [
  ["static compose safety", async () => runAllStaticChecks()],
  ["service health", async () => waitForHealthy({ timeoutMs: 60_000 })],
  ["secret security", async () => checkSecretSecurity()],
  ["TLS and reverse-proxy behavior", async () => checkTlsAndProxy()],
  ["container security posture", async () => checkContainerSecurity()],
  ["data persistence across restart", async () => checkPersistence()],
  ["failure isolation", async () => checkFailureIsolation()],
];

export async function labVerify() {
  let overallPass = true;

  for (const [label, run] of PHASES) {
    log(`\n▶ lab:verify: ${label}`);
    let result;
    try {
      result = await run();
    } catch (error) {
      log(`  ERROR: ${error.message}`);
      overallPass = false;
      continue;
    }
    const pass = result.pass ?? result.healthy;
    if (pass) {
      log("  PASS");
    } else {
      overallPass = false;
      for (const finding of result.findings ?? result.stillWaiting ?? []) {
        log(`  FAIL: ${finding}`);
      }
    }
  }

  if (overallPass) {
    log("\n✔ lab:verify PASSED — all reference-lab acceptance checks succeeded.");
  } else {
    logError("\n✖ lab:verify FAILED.");
  }
  return overallPass;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:verify");
    const passed = await labVerify();
    process.exit(passed ? 0 : 1);
  } catch (error) {
    logError(`lab:verify FAILED: ${error.message}`);
    process.exit(1);
  }
}
