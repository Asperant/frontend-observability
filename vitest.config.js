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
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
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
        "packages/browser-observability/src/config/**": {
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
      },
    },
  },
});
