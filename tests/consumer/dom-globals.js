import { JSDOM } from "jsdom";

/**
 * Consumer runtime-smoke checks execute a real Vite-built browser bundle
 * under plain Node. Vite's production output unconditionally references
 * `document` (e.g. its modulepreload polyfill), and React needs a DOM to
 * mount into, so a minimal JSDOM window is installed on globalThis first.
 */
export function installDomGlobals(html) {
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });

  return dom;
}

export function uninstallDomGlobals() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.navigator;
}
