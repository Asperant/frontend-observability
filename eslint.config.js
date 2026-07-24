import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

const noCommonJs = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "CallExpression[callee.name='require']",
      message: "CommonJS require() is forbidden. Use ESM import instead.",
    },
    {
      selector: "MemberExpression[object.name='module'][property.name='exports']",
      message: "CommonJS module.exports is forbidden. Use ESM export instead.",
    },
    {
      selector: "AssignmentExpression > MemberExpression.left[object.name='exports']",
      message: "CommonJS exports.xxx = ... is forbidden. Use ESM export instead.",
    },
  ],
  "no-restricted-globals": [
    "error",
    { name: "require", message: "CommonJS require() is forbidden." },
    { name: "module", message: "CommonJS module is forbidden." },
    { name: "__dirname", message: "__dirname is CommonJS-only. Use import.meta.url." },
    { name: "__filename", message: "__filename is CommonJS-only. Use import.meta.url." },
  ],
};

const noDangerousGlobals = {
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/blob-report/**",
      "**/.pnpm-store/**",
      "pnpm-lock.yaml",
    ],
  },

  js.configs.recommended,
  prettierConfig,

  // Default: no globals, ESM only, no CommonJS, no dangerous globals.
  {
    files: ["**/*.js", "**/*.jsx", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {},
    },
    rules: {
      ...noCommonJs,
      ...noDangerousGlobals,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },

  // packages/browser-observability: production package, browser runtime only.
  {
    files: ["packages/browser-observability/src/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react/*", "react-dom/*"],
              message:
                "packages/browser-observability must not depend on React or any UI framework.",
            },
            {
              group: ["**/apps/**", "**/demo-frontend/**", "**/mock-api/**"],
              message: "packages/browser-observability must not import demo or mock-api code.",
            },
          ],
        },
      ],
    },
  },

  // packages/contracts: production package, Node + browser agnostic (pure JS).
  {
    files: ["packages/contracts/src/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.es2021,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/apps/**", "react", "react-dom"],
              message: "packages/contracts must remain a framework-agnostic validation library.",
            },
          ],
        },
      ],
    },
  },

  // packages/durable-telemetry: Node-only durable delivery primitives.
  {
    files: ["packages/durable-telemetry/src/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // apps/demo-frontend: React + browser, may only use the public package API.
  {
    files: ["apps/demo-frontend/src/**/*.js", "apps/demo-frontend/src/**/*.jsx"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "19.2" },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@openobserve/*",
                "openobserve*",
                "@chicek/browser-observability/*",
                "**/browser-observability/src/**",
                "**/mock-api/**",
              ],
              message:
                "demo-frontend may only import the public @chicek/browser-observability API, never OpenObserve packages, internal package paths, or mock-api source.",
            },
          ],
        },
      ],
    },
  },

  // apps/mock-api: Node built-in HTTP only.
  {
    files: ["apps/mock-api/src/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // Stage 20.5 internal Node services.
  {
    files: ["apps/durable-ingest/src/**/*.js", "apps/delivery-worker/src/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // scripts/: Node tooling scripts, console output is expected.
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // scripts/performance/: also runs Playwright page.evaluate() closures
  // whose body text executes in the browser, not Node — those closures need
  // browser globals (document, performance.memory, etc.) recognized too.
  {
    files: ["scripts/performance/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // tests/ and every package/app test directory: Node + browser globals, console allowed.
  {
    files: [
      "**/tests/**/*.js",
      "**/*.test.js",
      "**/*.spec.js",
      "playwright.config.js",
      "vitest.config.js",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // Root-level and per-package config files run under Node.
  {
    files: [
      "*.config.js",
      "apps/*/vite.config.js",
      "packages/*/vite.config.js",
      "eslint.config.js",
      "prettier.config.js",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
];
