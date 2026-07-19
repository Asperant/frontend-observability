import { createAdapter } from "../adapter/openobserve/create-adapter.js";
import { createInitialRuntimeState } from "../lifecycle/state-machine.js";

export const RUNTIME_SYMBOL = Symbol.for("@chicek/browser-observability/runtime");

// The only place in the package that references a concrete adapter
// implementation. createAdapter() is a cheap, synchronous factory — it does
// not import or touch the OpenObserve SDK itself; that only happens inside
// the returned adapter's initialize(), via a dynamic import (see
// adapter/openobserve/load-sdk.js), and only once the coordinator has
// already resolved a valid, enabled runtime config.
const DEFAULT_ADAPTER_FACTORY = createAdapter;

let runtimeState = createInitialRuntimeState();
let adapterFactory = DEFAULT_ADAPTER_FACTORY;

export function ensureRuntimeRegistry() {
  if (!globalThis[RUNTIME_SYMBOL]) {
    Object.defineProperty(globalThis, RUNTIME_SYMBOL, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        lifecycleGeneration: 0,
        fingerprint: null,
        inFlightPromise: null,
      },
    });
  }
  return globalThis[RUNTIME_SYMBOL];
}

export function getExistingRuntimeRegistry() {
  return globalThis[RUNTIME_SYMBOL] ?? null;
}

export function getRuntimeState() {
  return runtimeState;
}

export function replaceRuntimeState(nextState = createInitialRuntimeState()) {
  runtimeState = nextState;
  return runtimeState;
}

export function getAdapterFactory() {
  return adapterFactory;
}

export function setAdapterFactoryForTests(factory) {
  adapterFactory = factory;
}

export function resetRuntimeRegistryForTests() {
  adapterFactory = DEFAULT_ADAPTER_FACTORY;
  runtimeState = createInitialRuntimeState();
  delete globalThis[RUNTIME_SYMBOL];
}
