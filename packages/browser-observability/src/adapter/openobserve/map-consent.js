import { CONSENT } from "../../internal/constants.js";

/**
 * Maps this package's internal consent value to the exact string literal
 * the OpenObserve/Datadog-derived browser SDKs' TrackingConsent expects.
 * The two vocabularies already agree ("granted" | "not-granted"); this
 * function still exists so the adapter never assumes that alignment
 * silently and always fails closed for anything unrecognized.
 */
export function mapConsent(consent) {
  return consent === CONSENT.GRANTED ? "granted" : "not-granted";
}
