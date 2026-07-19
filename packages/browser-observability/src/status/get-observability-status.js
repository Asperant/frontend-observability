import { getRuntimeState } from "../bootstrap/runtime-registry.js";
import { createStatusSnapshot } from "./snapshot.js";

export function getObservabilityStatus() {
  return createStatusSnapshot(getRuntimeState());
}
