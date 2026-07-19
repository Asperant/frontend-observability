const REQUIRED_METHODS = Object.freeze([
  "initialize",
  "setTrackingConsent",
  "recordAction",
  "recordError",
  "startSessionReplay",
  "stopSessionReplay",
  "shutdown",
  "getCapabilities",
]);

export function isValidAdapter(adapter) {
  return (
    adapter !== null &&
    typeof adapter === "object" &&
    typeof adapter.name === "string" &&
    adapter.name.length > 0 &&
    REQUIRED_METHODS.every((method) => typeof adapter[method] === "function")
  );
}

export async function initializeAdapter(adapterFactory, context) {
  if (typeof adapterFactory !== "function") {
    return { ok: false, adapter: null };
  }
  const adapter = await adapterFactory(context);
  if (!isValidAdapter(adapter)) {
    return { ok: false, adapter: null };
  }
  await adapter.initialize(context);
  return { ok: true, adapter };
}
