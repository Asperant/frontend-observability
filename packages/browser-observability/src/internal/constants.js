export const STATUS = Object.freeze({
  IDLE: "idle",
  UNINITIALIZED: "idle",
  INITIALIZING: "initializing",
  ACTIVE: "active",
  READY: "active",
  DISABLED: "disabled",
  DEGRADED: "degraded",
  SHUTTING_DOWN: "shutting-down",
  SHUTDOWN: "shutdown",
});

export const CONSENT = Object.freeze({
  GRANTED: "granted",
  NOT_GRANTED: "not-granted",
  DENIED: "not-granted",
  UNKNOWN: "not-granted",
});

export const PRIVACY_PROFILES = Object.freeze(["strict", "balanced"]);

export const MAX_DIAGNOSTICS = 50;
export const MAX_ACTION_NAME_LENGTH = 64;
export const MAX_ATTRIBUTE_COUNT = 20;
export const MAX_ATTRIBUTE_KEY_LENGTH = 64;
export const MAX_STRING_ATTRIBUTE_LENGTH = 256;

export const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const ATTRIBUTE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
