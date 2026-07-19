export function isBrowserRuntime() {
  return (
    typeof globalThis.window === "object" &&
    globalThis.window !== null &&
    typeof globalThis.document === "object" &&
    globalThis.document !== null &&
    typeof globalThis.fetch === "function" &&
    typeof globalThis.AbortController === "function"
  );
}

export function getRuntimeOrigin() {
  if (
    typeof globalThis.location === "object" &&
    globalThis.location !== null &&
    typeof globalThis.location.origin === "string"
  ) {
    return globalThis.location.origin;
  }
  if (
    typeof globalThis.window === "object" &&
    globalThis.window !== null &&
    typeof globalThis.window.location === "object" &&
    typeof globalThis.window.location.origin === "string"
  ) {
    return globalThis.window.location.origin;
  }
  return "http://localhost";
}
