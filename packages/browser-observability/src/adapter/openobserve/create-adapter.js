import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { buildLogsOptions } from "./build-logs-options.js";
import { buildRumOptions } from "./build-rum-options.js";
import { createCapabilities, UNAVAILABLE_CAPABILITIES } from "./capabilities.js";
import { loadOpenObserveSdk } from "./load-sdk.js";
import { mapAction } from "./map-action.js";
import { mapConsent } from "./map-consent.js";
import { mapError } from "./map-error.js";
import { computeSdkFingerprint } from "./sdk-fingerprint.js";

const CANARY_MESSAGE = "stage8.browser_logs.canary";
const CANARY_CONTEXT = Object.freeze({ component: "demo-fixture", outcome: "success" });

// The vendor SDK (@openobserve/browser-rum / @openobserve/browser-logs) is a
// true page-global singleton: both packages resolve to the same module
// instance for the lifetime of the page, they expose no destroy/dispose
// API, and a second real init() call on either is a documented, silent
// no-op (see build-rum-options.js's silentMultipleInit). createAdapter()
// itself is a cheap factory that the coordinator calls fresh on every
// initialize — including a real shutdown()+reinitialize() cycle — so "has
// the real SDK actually been initialized, and for which connection
// identity" cannot live in the per-call closure below; it has to live here,
// at module scope, for as long as the page/module instance is alive. This
// is exactly the state the duplicate-SDK-bundling contract test guards:
// there must only ever be one copy of this module (and therefore one copy
// of this singleton) per page.
let sdkSingleton = null;

export function resetOpenObserveAdapterForTests() {
  sdkSingleton = null;
}

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
    const fingerprint = computeSdkFingerprint(identity, policy.rum);

    if (sdkSingleton && sdkSingleton.fingerprint !== fingerprint) {
      // A real reinitialize with a different SDK connection identity is not
      // supported: the vendor SDK cannot be reconfigured once initialized,
      // and there is no way to guarantee the previously-sent data and the
      // newly-requested identity would not collide in OpenObserve. Fail
      // closed without touching the already-running SDK singleton at all —
      // its config, session, and consent state are left exactly as they
      // were.
      throw reinitializationUnsupported();
    }

    if (!sdkSingleton) {
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

      // Browser logs are a secondary channel: attempting it only when the
      // runtime config actually requests it, and only reporting a failure
      // (which the coordinator turns into a degraded state) when it was
      // requested but did not come up — never for a channel nobody asked
      // for.
      let logsOk = true;
      let logsModule = null;
      if (policy.browserLogs?.enabled) {
        try {
          sdk.logs.init(buildLogsOptions(identity, policy));
          logsModule = sdk.logs;
        } catch {
          logsOk = false;
          logsModule = null;
        }
      }

      // Store only the fingerprint (a hash, never the raw clientToken) and
      // the live SDK module references — nothing here is exposed through
      // getCapabilities()/status/diagnostics.
      sdkSingleton = { fingerprint, rum: sdk.rum, logs: logsModule, logsOk };
    }

    // Same fingerprint as an already-initialized singleton (either the
    // first initialize() above, or a resume after shutdown()): reuse the
    // existing SDK instance rather than calling its init() a second time.
    rum = sdkSingleton.rum;
    logs = sdkSingleton.logs;
    capabilities = createCapabilities({
      telemetry: true,
      logs: sdkSingleton.logsOk,
      sessionReplay: false,
    });

    // The SDK itself is always initialized with trackingConsent:"not-granted"
    // (see build-rum-options.js/build-logs-options.js) regardless of this
    // package's own current consent value, as a hard security default. Sync
    // the SDK to the real current consent right after init — this matters
    // most after a shutdown()+reinitialize() cycle where consent was
    // already "granted" before shutdown and never changes again afterward
    // (the coordinator only re-applies consent to the adapter when a caller
    // calls setTrackingConsent() with a *new* value), so without this the
    // real SDK would stay silently un-consented forever after a reinit. On
    // the resume path this is also what makes the SDK start tracking a new
    // session again: the SDK creates one lazily on the next accepted event
    // once consent is granted, there is no separate "start session" call.
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
    // the SDK itself never lets go of. The module-level sdkSingleton is
    // deliberately left in place (not cleared) so that a later
    // reinitialize() with the same fingerprint can resume it instead of
    // calling init() again; it carries no token value, only the fingerprint
    // hash and the live SDK module references. Everything else — this
    // adapter instance itself, the runtime's config/abort-controller state —
    // is discarded by the coordinator's own shutdown path
    // (lifecycle/shutdown.js), not retained here.
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

function reinitializationUnsupported() {
  // Carries no detail beyond the reasonCode: not which fields differed, and
  // never the fingerprint or token values themselves.
  const error = new Error(
    "openobserve adapter reinitialization with a different SDK identity is not supported",
  );
  error.reasonCode = ReasonCodes.SDK_REINITIALIZATION_UNSUPPORTED;
  return error;
}
