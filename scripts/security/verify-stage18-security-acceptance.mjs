import { spawnSync } from "node:child_process";

import { assertExactLabToolchain, log, logError } from "../lab/common.mjs";
import {
  checkAlertSinkNotificationPrivacy,
  checkBrowserStorageAuditLive,
  checkDockerCrossContainerIsolation,
  checkKillSwitchClosesUpstream,
  checkKillSwitchConcurrentRace,
  checkKillSwitchSymlinkAttack,
  checkLiveReplayRejection,
  checkManagementPlaneUnreachableViaProxy,
  checkRuntimeControlAdversarialDocuments,
  checkTokenCapabilityIsolation,
  restoreRuntimeControlBaseline,
} from "../../tests/security/stage18/lab-adversarial.js";

const LAB_CHECKS = [
  ["token capability isolation (Section 3)", checkTokenCapabilityIsolation],
  [
    "management plane unreachable via browser-facing proxy (Section 3)",
    checkManagementPlaneUnreachableViaProxy,
  ],
  ["live replay-endpoint rejection (Section 5)", checkLiveReplayRejection],
  ["runtime-control adversarial documents (Section 6)", checkRuntimeControlAdversarialDocuments],
  ["kill-switch symlink attack (Section 6)", checkKillSwitchSymlinkAttack],
  ["kill-switch concurrent on/off race (Section 6)", checkKillSwitchConcurrentRace],
  ["kill switch closes upstream (Section 6)", checkKillSwitchClosesUpstream],
  ["Docker cross-container admin isolation (Section 9)", checkDockerCrossContainerIsolation],
  ["alert-sink notification privacy (Section 10)", checkAlertSinkNotificationPrivacy],
  ["browser storage audit, Chromium + Firefox (Section 1)", checkBrowserStorageAuditLive],
];

function runPureLogicSuite() {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/security/stage18/browser-package-adversarial.test.js",
      "tests/security/stage18/governance-audit-adversarial.test.js",
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { pass: result.status === 0, output };
}

export async function verifyStage18SecurityAcceptance() {
  let overallPass = true;
  const report = [];

  log("▶ stage18: pure-logic adversarial suite (browser-package + governance-audit)");
  const pureLogic = runPureLogicSuite();
  if (pureLogic.pass) {
    log("  PASS");
  } else {
    overallPass = false;
    log("  FAIL");
    log(pureLogic.output.slice(-4000));
  }
  report.push({ check: "pure-logic adversarial suite", pass: pureLogic.pass });

  try {
    for (const [label, fn] of LAB_CHECKS) {
      log(`\n▶ stage18: ${label}`);
      const result = await fn();
      report.push({ check: label, pass: result.pass, findings: result.findings });
      if (result.pass) {
        log("  PASS");
      } else {
        overallPass = false;
        log("  FAIL");
        for (const finding of result.findings) log(`    - ${finding}`);
      }
    }
  } finally {
    await restoreRuntimeControlBaseline();
  }

  if (overallPass) {
    log("\n✔ stage18:security-acceptance PASSED — no open adversarial findings.");
  } else {
    logError("\n✖ stage18:security-acceptance FAILED.");
  }
  return { pass: overallPass, report };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("test:stage18:security-acceptance");
    const { pass } = await verifyStage18SecurityAcceptance();
    process.exit(pass ? 0 : 1);
  } catch (error) {
    logError(`test:stage18:security-acceptance FAILED: ${error.message}`);
    process.exit(1);
  }
}
