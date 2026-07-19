export const LifecycleStates = Object.freeze({
  IDLE: "idle",
  INITIALIZING: "initializing",
  ACTIVE: "active",
  DISABLED: "disabled",
  DEGRADED: "degraded",
  SHUTTING_DOWN: "shutting-down",
  SHUTDOWN: "shutdown",
});

export const TRANSITIONS = Object.freeze({
  [LifecycleStates.IDLE]: Object.freeze([LifecycleStates.INITIALIZING]),
  [LifecycleStates.INITIALIZING]: Object.freeze([
    LifecycleStates.ACTIVE,
    LifecycleStates.DISABLED,
    LifecycleStates.DEGRADED,
  ]),
  [LifecycleStates.ACTIVE]: Object.freeze([
    LifecycleStates.DEGRADED,
    LifecycleStates.SHUTTING_DOWN,
  ]),
  [LifecycleStates.DEGRADED]: Object.freeze([LifecycleStates.SHUTTING_DOWN]),
  [LifecycleStates.DISABLED]: Object.freeze([
    LifecycleStates.INITIALIZING,
    LifecycleStates.SHUTTING_DOWN,
  ]),
  [LifecycleStates.SHUTTING_DOWN]: Object.freeze([LifecycleStates.SHUTDOWN]),
  [LifecycleStates.SHUTDOWN]: Object.freeze([LifecycleStates.INITIALIZING]),
});

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}
