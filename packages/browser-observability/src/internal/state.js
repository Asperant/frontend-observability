import { CONSENT, STATUS } from "./constants.js";

function createInitialState() {
  return {
    status: STATUS.UNINITIALIZED,
    config: null,
    consent: CONSENT.UNKNOWN,
    initializedAt: null,
    lastError: null,
    diagnostics: [],
  };
}

let state = createInitialState();

/**
 * Returns the live module-level state object. This is internal-only:
 * it is never exported from src/index.js and must not be imported by
 * consumers or other packages.
 */
export function getState() {
  return state;
}

export function resetState() {
  state = createInitialState();
}
