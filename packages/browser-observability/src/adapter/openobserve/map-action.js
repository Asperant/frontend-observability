import { sanitizeAttributes } from "../../sanitization/sanitize-attributes.js";

/**
 * Maps a validated recordAction(name, attributes) call to the OpenObserve
 * RUM SDK's addAction(name, context) shape. `name` was already validated by
 * actions/validate-action-name.js before this ever runs; attributes are
 * bounded here so nothing unbounded/unsafe reaches the vendor SDK.
 */
export function mapAction(name, attributes) {
  return Object.freeze({ name, context: sanitizeAttributes(attributes) });
}
