import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(root, "src/index.js"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        preserveModules: false,
        // load-sdk.js (imported statically by the adapter, itself imported
        // statically by bootstrap/runtime-registry.js) dynamically imports
        // the two @openobserve/* packages at call time only — so Rollup
        // naturally code-splits them into their own chunk(s) instead of the
        // main entry, and that chunk never executes unless/until
        // initializeObservability() actually resolves enabled=true in a
        // browser. Without manualChunks, Rollup splits @openobserve/browser-rum,
        // @openobserve/browser-logs, and their shared @openobserve/browser-core
        // dependency into three separate hashed chunks; forcing every
        // @openobserve/* module into one fixed, unhashed chunk name keeps the
        // dynamic-import boundary a single reviewable file across rebuilds.
        // scripts/build/verify-build-gate.js allowlists this exact name.
        chunkFileNames: "[name].js",
        manualChunks(id) {
          if (id.includes("node_modules/@openobserve")) return "adapter-openobserve";
        },
      },
    },
  },
});
