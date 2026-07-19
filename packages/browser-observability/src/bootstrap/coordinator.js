import { initializeAdapter } from "../adapter/adapter-contract.js";
import { loadConfig } from "../config/load-config.js";
import { mergePrivacyPolicy } from "../config/merge-policy.js";
import { normalizeOptions, validateOptions } from "../config/validate-options.js";
import { grantCorrelationEpoch } from "../correlation/correlation-context.js";
import { ReasonCodes } from "../diagnostics/reason-codes.js";
import { CONSENT } from "../internal/constants.js";
import { fingerprintOptions } from "../internal/fingerprint.js";
import { isBrowserRuntime } from "../internal/environment.js";
import {
  activateRuntime,
  createInitialRuntimeState,
  degradeRuntime,
  disableRuntime,
  transition,
} from "../lifecycle/state-machine.js";
import { LifecycleStates } from "../lifecycle/transitions.js";
import { createStatusSnapshot } from "../status/snapshot.js";
import {
  ensureRuntimeRegistry,
  getAdapterFactory,
  getRuntimeState,
  replaceRuntimeState,
} from "./runtime-registry.js";

export function initializeCoordinator(options) {
  const registry = ensureRuntimeRegistry();
  const validation = validateOptions(options);
  const runtime = getRuntimeState();

  if (!validation.valid) {
    const nextRuntime = prepareInitializationRuntime(runtime);
    disableRuntime(nextRuntime, ReasonCodes.OPTIONS_INVALID);
    return Promise.resolve(result(false, nextRuntime));
  }

  const normalized = normalizeOptions(options);
  const fingerprint = fingerprintOptions(normalized);

  if (runtime.state === LifecycleStates.ACTIVE || runtime.state === LifecycleStates.DEGRADED) {
    if (registry.fingerprint === fingerprint) {
      return Promise.resolve(result(true, runtime));
    }
    return Promise.resolve(result(false, runtime, ReasonCodes.INITIALIZATION_CONFLICT));
  }

  if (registry.inFlightPromise) {
    if (registry.fingerprint === fingerprint) return registry.inFlightPromise;
    return Promise.resolve(result(false, runtime, ReasonCodes.INITIALIZATION_CONFLICT));
  }

  registry.fingerprint = fingerprint;
  registry.lifecycleGeneration += 1;
  const promise = runInitialization(registry, normalized).catch(() => {
    const failedRuntime = getRuntimeState();
    disableRuntime(failedRuntime, ReasonCodes.INTERNAL_ERROR);
    return result(false, failedRuntime, ReasonCodes.INTERNAL_ERROR);
  });
  registry.inFlightPromise = promise;
  promise.finally(() => {
    registry.inFlightPromise = null;
  });
  return promise;
}

async function runInitialization(registry, options) {
  const runtime = prepareInitializationRuntime(getRuntimeState());
  runtime.service = options.service;
  runtime.environment = options.environment;
  runtime.version = options.version;
  runtime.initializedAt = new Date().toISOString();
  runtime.abortController = new AbortController();

  if (!isBrowserRuntime()) {
    disableRuntime(runtime, ReasonCodes.UNSUPPORTED_RUNTIME);
    return result(false, runtime);
  }

  const loaded = await loadConfig(options.configUrl, { signal: runtime.abortController.signal });
  runtime.abortController = null;
  if (!loaded.ok) {
    disableRuntime(runtime, loaded.reasonCode);
    return result(false, runtime);
  }

  const policy = mergePrivacyPolicy(options, loaded.config);
  runtime.configVersion = loaded.config.configVersion ?? loaded.config.schemaVersion;

  if (!policy.telemetryEnabled) {
    disableRuntime(runtime, ReasonCodes.CONFIG_DISABLED);
    return result(false, runtime);
  }

  if (runtime.consent === CONSENT.GRANTED && !runtime.correlation.epochId) {
    if (!grantCorrelationEpoch(runtime.correlation)) {
      disableRuntime(runtime, ReasonCodes.CORRELATION_CONTEXT_UNAVAILABLE);
      return result(false, runtime);
    }
  }

  const adapterResult = await initializeAdapter(getAdapterFactory(), {
    service: options.service,
    environment: options.environment,
    version: options.version,
    consent: runtime.consent,
    policy,
    counters: runtime.counters,
    correlation: runtime.correlation,
  }).catch(() => ({ ok: false, adapter: null, thrown: true }));

  if (!adapterResult.ok) {
    if (adapterResult.reasonCode) {
      disableRuntime(runtime, adapterResult.reasonCode);
      return result(false, runtime);
    }
    if (adapterResult.thrown) {
      degradeRuntime(runtime, ReasonCodes.ADAPTER_ERROR);
      return result(false, runtime);
    }
    disableRuntime(runtime, ReasonCodes.ADAPTER_UNAVAILABLE);
    return result(false, runtime);
  }

  activateRuntime(runtime, adapterResult.adapter);
  const capabilities = safeGetCapabilities(adapterResult.adapter);
  if (capabilities.telemetry && capabilities.logs === false) {
    // Primary telemetry (RUM actions/errors) came up, but the adapter's
    // secondary channel (browser logs) failed to initialize: report the
    // package as degraded rather than fully active, without ever calling
    // adapter-specific (e.g. OpenObserve) logic from this generic coordinator.
    transition(runtime, LifecycleStates.DEGRADED, ReasonCodes.ADAPTER_ERROR);
  }
  return result(true, runtime);
}

function safeGetCapabilities(adapter) {
  try {
    const capabilities = adapter.getCapabilities();
    return capabilities && typeof capabilities === "object" ? capabilities : {};
  } catch {
    return {};
  }
}

function prepareInitializationRuntime(runtime) {
  if (runtime.state === LifecycleStates.IDLE || runtime.state === LifecycleStates.SHUTDOWN) {
    if (runtime.state === LifecycleStates.IDLE) {
      transition(runtime, LifecycleStates.INITIALIZING);
      return runtime;
    }
    const nextRuntime = createInitialRuntimeState();
    nextRuntime.consent = runtime.consent;
    replaceRuntimeState(nextRuntime);
    transition(nextRuntime, LifecycleStates.INITIALIZING);
    return nextRuntime;
  }
  if (runtime.state === LifecycleStates.DISABLED) {
    const nextRuntime = createInitialRuntimeState();
    nextRuntime.consent = runtime.consent;
    replaceRuntimeState(nextRuntime);
    transition(nextRuntime, LifecycleStates.INITIALIZING);
    return nextRuntime;
  }
  return runtime;
}

function result(ok, runtime, reasonCode = runtime.reasonCode) {
  return {
    ok,
    state: runtime.state,
    reasonCode,
    status: createStatusSnapshot(runtime),
  };
}
