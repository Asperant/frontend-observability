import { KILL_SWITCH_REASON_CODES } from "../../packages/browser-observability/src/runtime-control/constants.js";
import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { generateRuntimeControl, readCurrentRuntimeControl } from "./generate-runtime-control.mjs";
import {
  readProxyGateActive,
  reloadReverseProxy,
  waitForReloadSettle,
  writeProxyGate,
} from "./proxy-gate.mjs";

const ACTIVATION_REASON_CODES = KILL_SWITCH_REASON_CODES.filter((reason) => reason !== "none");

/**
 * Two independent layers, activated proxy-first: the browser-facing control
 * document can take up to one refresh cycle to reach an already-open page,
 * so the reverse-proxy path is closed — and reloaded — *before* the control
 * document is ever republished with active:true. See
 * docs/runtime-control-and-kill-switch.md.
 */
export async function killSwitchOn({ reason }) {
  if (!ACTIVATION_REASON_CODES.includes(reason)) {
    throw new Error(
      `--reason is required and must be one of: ${ACTIVATION_REASON_CODES.join(", ")}`,
    );
  }
  writeProxyGate(true);
  reloadReverseProxy();
  await waitForReloadSettle();
  const document = generateRuntimeControl({ killSwitch: { active: true, reasonCode: reason } });
  return { document, proxyGateActive: true };
}

/**
 * Deactivation is the mirror image, browser-first: the control document is
 * republished as active:false *before* the proxy path reopens, so there is
 * never a window where the proxy accepts traffic but a stale control
 * document is still telling pages the kill switch is on (the reverse would
 * momentarily do the opposite, briefly reopening ingestion before browsers
 * have any chance to resume — the fail-closed direction always wins first).
 */
export async function killSwitchOff() {
  const document = generateRuntimeControl({ killSwitch: { active: false, reasonCode: "none" } });
  writeProxyGate(false);
  reloadReverseProxy();
  await waitForReloadSettle();
  return { document, proxyGateActive: false };
}

export function killSwitchStatus() {
  const document = readCurrentRuntimeControl();
  return {
    proxyGateActive: readProxyGateActive(),
    control: document
      ? {
          revision: document.revision,
          issuedAt: document.issuedAt,
          expiresAt: document.expiresAt,
          killSwitch: document.killSwitch,
        }
      : null,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let reason;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--reason") reason = rest[i + 1];
  }
  return { command, reason };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:kill-switch");
    const { command, reason } = parseArgs(process.argv.slice(2));
    if (command === "on") {
      const result = await killSwitchOn({ reason });
      log(
        `kill switch ON — revision=${result.document.revision} reasonCode=${result.document.killSwitch.reasonCode} proxyGateActive=${result.proxyGateActive}`,
      );
    } else if (command === "off") {
      const result = await killSwitchOff();
      log(
        `kill switch OFF — revision=${result.document.revision} proxyGateActive=${result.proxyGateActive}`,
      );
    } else if (command === "status") {
      const status = killSwitchStatus();
      log(JSON.stringify(status, null, 2));
    } else {
      throw new Error(`unknown command "${command ?? ""}"; expected one of: on, off, status`);
    }
  } catch (error) {
    logError(`lab:kill-switch FAILED: ${error.message}`);
    process.exit(1);
  }
}
