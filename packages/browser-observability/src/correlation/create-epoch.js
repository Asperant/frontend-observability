import { validateCorrelationId } from "./validate-correlation-id.js";

const EPOCH_BYTES = 16;

export function createConsentEpoch() {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject || typeof cryptoObject.getRandomValues !== "function") {
    return null;
  }
  const bytes = new Uint8Array(EPOCH_BYTES);
  cryptoObject.getRandomValues(bytes);
  const epoch = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  /* v8 ignore next -- generated hex from 16 bytes is always a valid controlled ASCII ID */
  if (!validateCorrelationId(epoch)) return null;
  return epoch;
}
