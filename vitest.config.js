import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "jsdom",
          include: [
            "packages/browser-observability/tests/**/*.test.js",
            "packages/contracts/tests/**/*.test.js",
            "apps/mock-api/tests/**/*.test.js",
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      {
        test: {
          name: "contract",
          environment: "node",
          include: ["tests/contract/**/*.test.js"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      {
        test: {
          name: "consumer",
          environment: "node",
          include: ["tests/consumer/**/*.test.js"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          // Docker-independent: exercises pure logic and reads the repo's
          // own compose.yaml/images.lock.json/Dockerfiles from disk. Not
          // part of `pnpm verify` — run explicitly via `pnpm test:lab`.
          name: "lab",
          environment: "node",
          include: ["tests/lab/**/*.test.js"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      {
        test: {
          // Regression tests for scripts/security/scan-secrets.js. Part of
          // `pnpm verify` (via `test:security`) so the scanner's own
          // detection/exclusion contracts are enforced on every run, not
          // just exercised ad hoc.
          name: "security",
          environment: "node",
          include: ["tests/security/**/*.test.js"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      // scripts/lab/streams/**/*.js is deliberately NOT in this default
      // include list: `pnpm test:coverage` (--project unit) never touches
      // it, so folding it in here would dilute/break the existing global
      // thresholds below with 0%-covered files the "unit" project never
      // runs. It is only measured when `pnpm test:stage15:streams`
      // (scripts/lab/verify-stage15-streams.mjs) explicitly runs vitest
      // with a --coverage.include override scoped to just that path — see
      // the "scripts/lab/streams/**" entry in `thresholds` below, which
      // stays dormant here and only applies to that scoped run.
      include: ["packages/browser-observability/src/**/*.js"],
      exclude: [
        "packages/browser-observability/src/internal/generated/**",
        "packages/browser-observability/tests/**",
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
        "packages/browser-observability/src/privacy/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "packages/browser-observability/src/sanitization/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "packages/browser-observability/src/correlation/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "packages/browser-observability/src/config/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "packages/browser-observability/src/bootstrap/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "packages/browser-observability/src/consent/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "packages/browser-observability/src/lifecycle/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "packages/browser-observability/src/status/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "scripts/lab/streams/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
        "scripts/lab/dashboards/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
  },
});
