import { PRIVACY_BASELINE } from "../privacy/privacy-baseline.js";

export const DEFAULT_OPTIONS = Object.freeze({
  environment: "production",
  privacyProfile: "strict",
  ...PRIVACY_BASELINE,
});
