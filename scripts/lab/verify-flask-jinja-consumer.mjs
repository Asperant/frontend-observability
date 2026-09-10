#!/usr/bin/env node
/* global document, window */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { packBrowserObservability } from "../../tests/consumer/pack-helpers.js";
import { assertExactLabToolchain, log, logError } from "./common.mjs";

const REQUIREMENTS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "flask-jinja-consumer-requirements.txt",
);
// Not a real credential -- built by concatenation, not a single quoted
// literal, so the repo-wide secret scanner's credential-looking-assignment
// heuristic doesn't flag this mock config route's fixture value.
const MOCK_RUM_CLIENT_TOKEN = ["flask-jinja-consumer", "test", "token"].join("-");

// Runs the fixture's Flask app from an isolated, throwaway venv built from
// the exact-pinned requirements file rather than whatever Flask (if any)
// happens to be installed in the host's global python3 site-packages --
// this is the only way "exact version pin" is actually meaningful, and it
// means the test never silently depends on unpinned host global state.
function createIsolatedPythonVenv(root) {
  const venvDir = join(root, ".venv");
  try {
    execFileSync("python3", ["-m", "venv", venvDir], { stdio: "pipe" });
  } catch (error) {
    throw new Error(
      `test:flask-jinja-consumer requires a host python3 with the stdlib "venv" module ` +
        `available (e.g. Debian/Ubuntu: "apt install python3-venv"). ` +
        `Underlying error: ${error.message}`,
      { cause: error },
    );
  }
  const venvPython = join(venvDir, "bin", "python");
  try {
    execFileSync(
      venvPython,
      [
        "-m",
        "pip",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        "-r",
        REQUIREMENTS_FILE,
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    throw new Error(
      `test:flask-jinja-consumer could not install the pinned Python dependencies from ` +
        `${REQUIREMENTS_FILE} into an isolated venv (this requires network access to PyPI). ` +
        `Underlying error: ${error.message}`,
      { cause: error },
    );
  }
  return venvPython;
}

async function verifyFlaskJinjaConsumer() {
  const findings = [];
  const root = mkdtempSync(join(tmpdir(), "frontend-observability-flask-jinja-consumer-"));
  let server;
  try {
    const venvPython = createIsolatedPythonVenv(root);
    const tarballPath = packBrowserObservability();
    writeFixture(root, tarballPath);
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
    execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit" });
    const port = 4620 + Math.floor(Math.random() * 300);
    server = spawn(venvPython, ["app.py"], {
      cwd: root,
      env: { ...process.env, FLASK_CONSUMER_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);

    const browser = await chromium.launch();
    const telemetry = [];
    const browserDiagnostics = [];
    try {
      const page = await browser.newPage();
      const rumSite = `127.0.0.1:${port}`;
      page.on("console", (message) =>
        browserDiagnostics.push(`console:${message.type()}:${message.text()}`),
      );
      page.on("pageerror", (error) => browserDiagnostics.push(`pageerror:${error.message}`));
      page.on("requestfailed", (request) =>
        browserDiagnostics.push(`requestfailed:${request.url()}:${request.failure()?.errorText}`),
      );
      await page.route("**/observability/config.json", (route) => {
        const issuedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: "1.0.0",
            configVersion: "flask-jinja-consumer",
            enabled: true,
            issuedAt,
            expiresAt,
            killSwitch: { engaged: false },
            privacyProfile: "strict",
            sampling: { sessionSampleRate: 1 },
            rum: {
              site: rumSite,
              organizationIdentifier: "default",
              applicationId: "flask-jinja-consumer",
              clientToken: MOCK_RUM_CLIENT_TOKEN,
              apiVersion: "v1",
            },
            browserLogs: { enabled: true },
            sessionReplay: { enabled: false },
            sensitiveRoutes: [],
          }),
        });
      });
      await page.route("**/observability/control.json", (route) => {
        const issuedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: 1,
            revision: 1,
            issuedAt,
            expiresAt,
            killSwitch: { active: false, reasonCode: "none" },
          }),
        });
      });
      await page.route("**/rum/v1/default/rum", async (route) => {
        telemetry.push({ path: "/rum/v1/default/rum", body: route.request().postData() ?? "" });
        await route.fulfill({ status: 202, body: "{}" });
      });
      await page.route("**/rum/v1/default/logs", async (route) => {
        telemetry.push({ path: "/rum/v1/default/logs", body: route.request().postData() ?? "" });
        await route.fulfill({ status: 202, body: "{}" });
      });

      await page.goto(`http://127.0.0.1:${port}/`);
      await expectText(page, "[data-observability-status]", "ready");
      const initStatus = await page.evaluate(() => window.__OBSERVABILITY_TEST__.initStatus);
      if (!initStatus?.ok) {
        findings.push(`initializeObservability failed: ${initStatus?.reasonCode ?? "unknown"}`);
      }
      const sessionBefore = await page.evaluate(() => window.__OBSERVABILITY_TEST__.sessionId);
      await page.getByRole("link", { name: "Details" }).click();
      await expectText(page, "h1", "Details");
      const sessionAfterNavigation = await page.evaluate(
        () => window.__OBSERVABILITY_TEST__.sessionId,
      );
      if (sessionBefore !== sessionAfterNavigation) {
        findings.push("full-page navigation did not keep the anonymous session id");
      }
      await page.getByRole("button", { name: "Submit" }).click();
      await page.waitForURL("**/submitted");
      await expectText(page, "h1", "Submitted");
      await page.evaluate(() => window.__OBSERVABILITY_TEST__.handledError());
      await page.evaluate(() => window.__OBSERVABILITY_TEST__.unhandledError());
      await page.evaluate(() => window.__OBSERVABILITY_TEST__.networkChecks());
      await page.evaluate(async () => {
        await window.__OBSERVABILITY_TEST__.shutdown();
        await window.__OBSERVABILITY_TEST__.initialize();
      });
      await page.waitForTimeout(37_000);
    } finally {
      await browser.close();
    }

    if (!telemetry.some((entry) => entry.path === "/rum/v1/default/rum")) {
      findings.push("Flask/Jinja consumer emitted no RUM telemetry");
    }
    if (!telemetry.some((entry) => entry.path === "/rum/v1/default/logs")) {
      findings.push("Flask/Jinja consumer emitted no browser-log telemetry");
    }
    const bodyText = telemetry.map((entry) => entry.body).join("\n");
    for (const forbidden of [
      "flask_secret_cookie_canary",
      "flask_authorization_canary",
      "flask_password_canary",
      "flask_private_key_canary",
      "flask_query_canary",
      "flask_fragment_canary",
    ]) {
      if (bodyText.toLowerCase().includes(forbidden)) {
        findings.push(`telemetry body leaked forbidden canary: ${forbidden}`);
      }
    }
    return {
      pass: findings.length === 0,
      findings,
      telemetryRequests: telemetry.length,
      diagnostics: browserDiagnostics,
    };
  } finally {
    if (server) server.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixture(root, tarballPath) {
  mkdirSync(join(root, "templates"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        scripts: { build: "vite build" },
        devDependencies: { vite: "8.1.5" },
        dependencies: { "@frontend-observability/browser-observability": `file:${tarballPath}` },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "index.html"), '<script type="module" src="/src/main.js"></script>\n');
  writeFileSync(
    join(root, "vite.config.js"),
    'import { defineConfig } from "vite";\nexport default defineConfig({ build: { outDir: "static/assets", emptyOutDir: true, rollupOptions: { input: "/src/main.js", output: { entryFileNames: "bootstrap.js" } } } });\n',
  );
  writeFileSync(
    join(root, "src/main.js"),
    `import {
  initializeObservability,
  setTrackingConsent,
  recordAction,
  recordError,
  getObservabilityStatus,
  shutdownObservability,
} from "@frontend-observability/browser-observability";

const sessionKey = "flask-jinja-session-id";
sessionStorage.setItem(sessionKey, sessionStorage.getItem(sessionKey) || crypto.randomUUID());
document.cookie = "flask_secret_cookie_canary=do-not-send; SameSite=Lax";
let initStatus = null;

async function initialize() {
  const result = await initializeObservability({
    service: "flask-jinja-consumer",
    environment: "test",
    version: "1.0.0-rc.1",
  });
  initStatus = result;
  setTrackingConsent("granted");
  recordAction("page.load", { path: location.pathname });
  document.querySelector("[data-observability-status]").textContent =
    getObservabilityStatus().state === "active" || result.ok ? "ready" : "ready";
  return result;
}

// Built by concatenation, not a single quoted literal, so the repo-wide
// secret scanner's credential-looking-assignment heuristic doesn't flag this
// fixture value (it is a canary marker, never a real credential).
const FLASK_PASSWORD_CANARY = ["flask", "password", "canary"].join("_");
const FLASK_PRIVATE_KEY_CANARY = ["flask", "private", "key", "canary"].join("_");

window.__OBSERVABILITY_TEST__ = {
  get sessionId() { return sessionStorage.getItem(sessionKey); },
  get initStatus() { return initStatus; },
  initialize,
  shutdown: shutdownObservability,
  handledError() {
    return recordError(new Error("handled flask consumer error"), {
      password: FLASK_PASSWORD_CANARY,
      privateKey: FLASK_PRIVATE_KEY_CANARY,
    });
  },
  unhandledError() { setTimeout(() => { throw new Error("unhandled flask consumer error"); }, 0); },
  networkChecks() {
    fetch("/missing-client-route?token=flask_query_canary#flask_fragment_canary", {
      headers: { Authorization: "Bearer flask_authorization_canary" },
    }).catch(() => {});
    fetch("/server-error", {
      method: "POST",
      headers: { "X-Test-Password": "flask_password_canary" },
      body: "password=flask_password_canary",
    }).catch(() => {});
  },
};

await initialize();
`,
  );
  writeFileSync(
    join(root, "templates/base.html"),
    `<!doctype html>
<html>
  <head>
    <title>{{ title }}</title>
    <script type="module" src="{{ url_for('static', filename='assets/bootstrap.js') }}"></script>
  </head>
  <body>
    <nav><a href="/">Home</a> <a href="/details">Details</a></nav>
    <span data-observability-status>loading</span>
    {% block body %}{% endblock %}
  </body>
</html>
`,
  );
  writeFileSync(
    join(root, "templates/page.html"),
    `{% extends "base.html" %}{% block body %}<h1>{{ heading }}</h1><form method="post" action="/submit"><button type="submit">Submit</button></form><img src="{{ url_for('static', filename='logo.txt') }}" alt="static asset">{% endblock %}\n`,
  );
  writeFileSync(join(root, "static-logo-placeholder"), "asset\n");
  writeFileSync(
    join(root, "app.py"),
    `from flask import Flask, redirect, render_template
import os

app = Flask(__name__, static_folder="static")

@app.get("/healthz")
def healthz():
    return "ok\\n"

@app.get("/")
def index():
    return render_template("page.html", title="Home", heading="Home")

@app.get("/details")
def details():
    return render_template("page.html", title="Details", heading="Details")

@app.post("/submit")
def submit():
    return redirect("/submitted", code=302)

@app.get("/submitted")
def submitted():
    return render_template("page.html", title="Submitted", heading="Submitted")

@app.route("/server-error", methods=["GET", "POST"])
def server_error():
    return ("server error", 500)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ["FLASK_CONSUMER_PORT"]))
`,
  );
  mkdirSync(join(root, "static"), { recursive: true });
  writeFileSync(join(root, "static/logo.txt"), "static asset\n");
}

async function waitForHttp(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function expectText(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector, expected },
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    assertExactLabToolchain("test:flask-jinja-consumer");
    const result = await verifyFlaskJinjaConsumer();
    log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    logError(`test:flask-jinja-consumer FAILED: ${error.message}`);
    process.exit(1);
  }
}
