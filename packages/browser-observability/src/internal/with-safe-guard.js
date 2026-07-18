import { recordDiagnostic } from "../diagnostics/record-diagnostic.js";

/**
 * Wraps a function so it can never throw across the public API boundary.
 * Any unexpected internal error is captured as a diagnostic event and a
 * caller-supplied fallback value is returned instead.
 */
export function withSafeGuard(fn, fallback) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      try {
        recordDiagnostic(
          "error",
          "internal.unexpected_exception",
          error instanceof Error ? error.message : String(error),
        );
      } catch {
        // Diagnostics recording itself must never be able to throw.
      }
      return typeof fallback === "function" ? fallback(error) : fallback;
    }
  };
}
