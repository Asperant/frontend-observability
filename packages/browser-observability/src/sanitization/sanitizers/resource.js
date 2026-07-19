import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { drop, isDrop } from "../diagnostics/results.js";
import { sanitizeUrl } from "./url.js";

export function sanitizeResource(resource, options = {}) {
  try {
    const url = sanitizeUrl(resource?.url, { ...options, resource: true });
    if (isDrop(url)) return url;
    return url;
  } catch {
    /* v8 ignore next -- defensive fail-closed guard for unexpected host runtime faults */
    return drop(ReasonCodes.SANITIZER_FAILURE);
  }
}
