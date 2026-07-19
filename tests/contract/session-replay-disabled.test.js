import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateRuntimeConfig } from "../../packages/contracts/src/validators.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readSource(relativePath) {
  return readFileSync(`${repoRoot}${relativePath}`, "utf8");
}

// See docs/session-replay-security-decision.md: OpenObserve OSS v0.91.0 does
// no server-side content validation of session-replay segments (only the
// multipart/deflate envelope), so a schema-valid malicious payload sent
// directly with the real RUM client token lands in `_sessionreplay`
// unmodified. Client-side masking is therefore not a security boundary and
// session replay is unsupported until a reliable server-side fail-closed
// control exists. Every check below pins a piece of that closed state down
// as a permanent regression guard — if any of these ever needs to change to
// make a test pass, that is a signal replay is being re-enabled, and the
// decision doc must be revisited first, not the test.
describe("session replay stays disabled by design (OpenObserve OSS v0.91.0 security decision)", () => {
  describe("runtime config schema cannot express an enabled replay feature", () => {
    it("rejects an unknown top-level `features` key", () => {
      const config = validEnabledConfig();
      config.features = { sessionReplay: true };
      expect(validateRuntimeConfig(config).valid).toBe(false);
    });

    it("rejects an unknown top-level `replay` key", () => {
      const config = validEnabledConfig();
      config.replay = { privacyLevel: "mask" };
      expect(validateRuntimeConfig(config).valid).toBe(false);
    });

    it("rejects an unknown `sampling.sessionReplay` key", () => {
      const config = validEnabledConfig();
      config.sampling.sessionReplay = 100;
      expect(validateRuntimeConfig(config).valid).toBe(false);
    });

    it("requires sessionReplay.enabled to be exactly `false` — `true` is rejected", () => {
      const config = validEnabledConfig();
      config.sessionReplay.enabled = true;
      expect(validateRuntimeConfig(config).valid).toBe(false);
    });

    it("still accepts the config once every replay-adjacent field is removed", () => {
      expect(validateRuntimeConfig(validEnabledConfig()).valid).toBe(true);
    });

    function validEnabledConfig() {
      return {
        schemaVersion: "1.0.0",
        enabled: true,
        issuedAt: "2026-07-19T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        killSwitch: { engaged: false },
        privacyProfile: "strict",
        sampling: { sessionSampleRate: 1, errorSampleRate: 1 },
        rum: {
          site: "localhost:8443",
          organizationIdentifier: "default",
          applicationId: "app",
          clientToken: "a".repeat(48),
          apiVersion: "v1",
        },
        browserLogs: { enabled: true },
        sessionReplay: { enabled: false },
        allowedRoutes: [],
        allowedSelectors: [],
      };
    }
  });

  describe("the real RUM init options never allow replay to sample or start", () => {
    const source = readSource(
      "packages/browser-observability/src/adapter/openobserve/build-rum-options.js",
    );

    it("hardcodes sessionReplaySampleRate to the literal 0, not a policy-derived value", () => {
      expect(source).toMatch(/sessionReplaySampleRate:\s*0\b/);
    });

    it("hardcodes startSessionReplayRecordingManually to true (manual-start-only)", () => {
      expect(source).toMatch(/startSessionReplayRecordingManually:\s*true\b/);
    });

    it("keeps the existing safe defaultPrivacyLevel unchanged (mask-user-input, not weakened or repurposed)", () => {
      expect(source).toMatch(/defaultPrivacyLevel:\s*"mask-user-input"/);
    });
  });

  describe("the OpenObserve adapter never calls the real SDK's replay-start method", () => {
    const source = readSource(
      "packages/browser-observability/src/adapter/openobserve/create-adapter.js",
    );

    it("never references startSessionReplayRecording (the SDK's manual-start call)", () => {
      expect(source).not.toContain("startSessionReplayRecording");
    });

    it("startSessionReplay() always reports ok:false and never touches `rum`", () => {
      const match = source.match(/function startSessionReplay\(\)\s*{([\s\S]*?)\n {2}}/);
      expect(match, "startSessionReplay() function body not found").toBeTruthy();
      const body = match[1];
      expect(body).not.toMatch(/\brum\b/);
      expect(body).toMatch(/return\s*{\s*ok:\s*false\s*}/);
    });
  });

  describe("no code or fixture ever passes force:true to a session-replay call", () => {
    it("packages/browser-observability/src contains no force:true / force: true literal", () => {
      const files = [
        "packages/browser-observability/src/adapter/openobserve/create-adapter.js",
        "packages/browser-observability/src/adapter/openobserve/build-rum-options.js",
      ];
      for (const file of files) {
        expect(readSource(file)).not.toMatch(/force\s*:\s*true/);
      }
    });
  });

  describe("the reverse proxy never opens a session-replay ingestion path", () => {
    const source = readSource("infrastructure/docker/reverse-proxy/conf.d/ingestion.conf");

    it("has no location matching a /replay path", () => {
      expect(source).not.toMatch(/location\s*[=~]?\s*\/rum\/v1\/default\/replay/);
      for (const match of source
        .toLowerCase()
        .matchAll(/location[^{]*replay[^{]*{([\s\S]*?)\n}/g)) {
        expect(match[1]).not.toContain("proxy_pass");
        expect(match[1]).toContain("return 404");
      }
    });

    it("has exactly the two allowlisted rum/logs locations, and no others matching /rum/*", () => {
      const exactRumLocations = [
        ...source.matchAll(/^location = (\/rum\/v1\/default\/\S+) \{/gm),
      ].map((match) => match[1]);
      expect(new Set(exactRumLocations)).toEqual(
        new Set(["/rum/v1/default/rum", "/rum/v1/default/logs"]),
      );
    });

    it("denies every other /rum/ path with a plain 404, never a wildcard proxy_pass", () => {
      const catchAll = source.match(/location \/rum\/ \{([\s\S]*?)\n}/);
      expect(catchAll, "catch-all /rum/ location not found").toBeTruthy();
      expect(catchAll[1]).toMatch(/return 404;/);
      expect(catchAll[1]).not.toContain("proxy_pass");
    });

    it("contains no proxy_pass to openobserve outside the two allowlisted exact locations", () => {
      const proxyPassCount = (source.match(/proxy_pass \$openobserve_upstream\$uri\?/g) ?? [])
        .length;
      expect(proxyPassCount).toBe(2);
    });
  });
});
