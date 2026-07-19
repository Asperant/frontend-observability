import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { buildLogsOptions } from "./build-logs-options.js";
import { buildRumOptions } from "./build-rum-options.js";
import { createCapabilities, UNAVAILABLE_CAPABILITIES } from "./capabilities.js";
import { loadOpenObserveSdk } from "./load-sdk.js";
import { mapAction } from "./map-action.js";
import { mapConsent } from "./map-consent.js";
import { mapError } from "./map-error.js";

const CANARY_MESSAGE = "stage8.browser_logs.canary";
const CANARY_CONTEXT = Object.freeze({ component: "demo-fixture", outcome: "success" });

/**
 * Adapter factory for the real OpenObserve browser RUM + Logs integration.
 * This is the only file in the package that wires the vendor SDK behind the
 * shared adapter contract (adapter/adapter-contract.js); every other file in
 * this directory is a small, independently testable piece of it. Raw SDK
 * objects never leave this closure — only the 8 adapter-contract methods do.
 */
export function createAdapter() {
  let rum = null;
  let logs = null;
  let capabilities = UNAVAILABLE_CAPABILITIES;
  let canaryLogged = false;

  function applyConsent(consent) {
    const mapped = mapConsent(consent);
    rum?.setTrackingConsent(mapped);
    logs?.setTrackingConsent(mapped);
    if (mapped === "granted" && logs && !canaryLogged) {
      canaryLogged = true;
      logs.logger.log(CANARY_MESSAGE, CANARY_CONTEXT, "info");
    }
    return { ok: true };
  }

  async function initialize(context) {
    const identity = {
      service: context.service,
      environment: context.environment,
      version: context.version,
    };
    const policy = context.policy;

    let sdk;
    try {
      sdk = await loadOpenObserveSdk();
    } catch {
      throw initializationFailure();
    }

    try {
      sdk.rum.init(buildRumOptions(identity, policy));
    } catch {
      throw initializationFailure();
    }
    rum = sdk.rum;

    // Browser logs are a secondary channel: attempting it only when the
    // runtime config actually requests it, and only reporting a failure
    // (which the coordinator turns into a degraded state) when it was
    // requested but did not come up — never for a channel nobody asked for.
    let logsOk = true;
    if (policy.browserLogs?.enabled) {
      try {
        sdk.logs.init(buildLogsOptions(identity, policy));
        logs = sdk.logs;
      } catch {
        logsOk = false;
        logs = null;
      }
    }

    capabilities = createCapabilities({ telemetry: true, logs: logsOk, sessionReplay: false });

    // The SDK itself is always initialized with trackingConsent:"not-granted"
    // (see build-rum-options.js/build-logs-options.js) regardless of this
    // package's own current consent value, as a hard security default. Sync
    // the SDK to the real current consent right after init — this matters
    // most after a shutdown()+reinitialize() cycle where consent was
    // already "granted" before shutdown and never changes again afterward
    // (the coordinator only re-applies consent to the adapter when a caller
    // calls setTrackingConsent() with a *new* value), so without this the
    // real SDK would stay silently un-consented forever after a reinit.
    applyConsent(context.consent);
  }

  function recordAction(name, attributes) {
    if (!rum) return { ok: false };
    const mapped = mapAction(name, attributes);
    rum.addAction(mapped.name, mapped.context);
    return { ok: true };
  }

  function recordError(error, context) {
    const mapped = mapError(error, context);
    // Use whichever real, native SDK API is actually available; never send
    // the same error through both channels.
    if (rum) {
      rum.addError(mapped.error, mapped.context);
    } else if (logs) {
      logs.logger.error(mapped.error.message, mapped.context, mapped.error);
    } else {
      return { ok: false };
    }
    return { ok: true };
  }

  function startSessionReplay() {
    // Session replay is out of scope for this stage and must never
    // actually start, regardless of what a caller requests.
    return { ok: false };
  }

  function stopSessionReplay() {
    rum?.stopSessionReplayRecording();
    return { ok: true };
  }

  function shutdown() {
    // The vendor SDK exposes no destroy/dispose API (confirmed by reading
    // its source: a second init() call on the same page is a documented,
    // silent no-op). Shutdown therefore closes consent and ends the current
    // session — the real, supported way to stop this adapter from sending
    // anything further — rather than pretending to tear down a singleton
    // the SDK itself never lets go of.
    rum?.setTrackingConsent("not-granted");
    logs?.setTrackingConsent("not-granted");
    rum?.stopSession();
    return { ok: true };
  }

  function getCapabilities() {
    return capabilities;
  }

  return Object.freeze({
    name: "openobserve",
    initialize,
    setTrackingConsent: applyConsent,
    recordAction,
    recordError,
    startSessionReplay,
    stopSessionReplay,
    shutdown,
    getCapabilities,
  });
}

function initializationFailure() {
  // Deliberately carries no detail from the underlying cause: the adapter
  // contract only ever reads `.reasonCode` off this error, and nothing about
  // the vendor SDK's internal failure should be retained even transiently.
  const error = new Error("openobserve adapter initialization failed");
  error.reasonCode = ReasonCodes.ADAPTER_INITIALIZATION_FAILED;
  return error;
}
