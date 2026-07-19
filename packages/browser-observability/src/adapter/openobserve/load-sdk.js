/**
 * The only place in this package that imports the OpenObserve browser SDK
 * packages, and it does so lazily: these two specifiers are only reached
 * once this function is actually called (from create-adapter.js's
 * initialize(), itself only invoked by the coordinator after it has already
 * resolved a valid, enabled runtime config in a real browser). Nothing here
 * runs at module-evaluation time, so importing this package's public
 * index.js — including during SSR or with enabled=false — never loads or
 * executes the vendor SDK.
 */
export async function loadOpenObserveSdk() {
  const [rumModule, logsModule] = await Promise.all([
    import("@openobserve/browser-rum"),
    import("@openobserve/browser-logs"),
  ]);
  return Object.freeze({ rum: rumModule.openobserveRum, logs: logsModule.openobserveLogs });
}
