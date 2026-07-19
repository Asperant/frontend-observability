import { createInitialRuntimeState } from "../lifecycle/state-machine.js";

export const RUNTIME_SYMBOL = Symbol.for("@chicek/browser-observability/runtime");

let runtimeState = createInitialRuntimeState();
let adapterFactory = null;

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
  adapterFactory = null;
  runtimeState = createInitialRuntimeState();
  delete globalThis[RUNTIME_SYMBOL];
}
