import { getRuntimeState, resetRuntimeRegistryForTests } from "../bootstrap/runtime-registry.js";

/**
 * Compatibility helper for existing internal tests and diagnostics.
 * The public package never exports this state object.
 */
export function getState() {
  return getRuntimeState();
}

export function resetState() {
  resetRuntimeRegistryForTests();
}
