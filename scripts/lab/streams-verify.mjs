// `pnpm lab:streams:verify` — read-back-only API + drift/hash check for
// both canonical streams: settings drift (vs the desired manifest), native
// schema type drift (vs the schema-contract's knownFieldTypes), and
// pipeline destination drift (the Stage 9 sanitization pipeline must still
// target the same canonical stream it was provisioned against). Never
// writes. A stable settings hash is printed per stream so a human/CI diff
// across two runs can spot a change even without re-reading this script's
// own diff output.

import { createHash } from "node:crypto";

import { assertExactLabToolchain, log, logError } from "./common.mjs";
import { getStreamSchema, listPipelines, readAdminAuthHeader } from "./streams/admin-client.mjs";
import { DRIFT_CLASS, classifyDrift, classifyPipelineDestination } from "./streams/drift.js";
import { loadAllStreamDefinitions } from "./streams/load-manifests.mjs";
import { diffSettings, normalizeServerSettings } from "./streams/manifest.js";
import { detectTypeChanges } from "./streams/schema-contract.js";

const PIPELINE_NAME_BY_STREAM = Object.freeze({
  _rumdata: "chicek_rumdata_sanitize_pipeline_v1",
  _rumlog: "chicek_rumlog_sanitize_pipeline_v1",
});

function hashSettings(normalizedSettings) {
  return createHash("sha256").update(JSON.stringify(normalizedSettings)).digest("hex").slice(0, 16);
}

export async function streamsVerify() {
  const auth = readAdminAuthHeader();
  const pipelines = await listPipelines(auth);
  const results = [];

  for (const { manifest, contract } of loadAllStreamDefinitions()) {
    const schema = await getStreamSchema(auth, manifest.streamName, manifest.streamType);
    if (!schema) {
      results.push({
        stream: manifest.streamName,
        exists: false,
        drift: { overall: DRIFT_CLASS.BREAKING_SCHEMA_DRIFT, findings: [] },
      });
      continue;
    }

    const normalized = normalizeServerSettings(schema.settings, manifest.volatileServerFields);
    const settingsDiffs = diffSettings(manifest.desiredSettings, normalized);
    const typeChanges = detectTypeChanges(contract, schema.schema);

    const pipeline = pipelines.find(
      (entry) => entry?.name === PIPELINE_NAME_BY_STREAM[manifest.streamName],
    );
    const pipelineFindings = classifyPipelineDestination(pipeline, manifest.streamName);

    const drift = classifyDrift({
      settingsDiffs,
      schemaFindings:
        typeChanges.length > 0
          ? [
              {
                validation: {
                  missingRequired: [],
                  forbiddenPresent: [],
                  forbiddenPatternMatches: [],
                  uncontrolledChicek: [],
                  unknownAdditive: [],
                  urlLeaks: [],
                  valuePatternMatches: [],
                },
                typeChanges,
              },
            ]
          : [],
      pipelineFindings,
    });

    results.push({
      stream: manifest.streamName,
      exists: true,
      settingsHash: hashSettings(normalized),
      settingsDiffs,
      typeChanges,
      pipelineFound: Boolean(pipeline),
      drift,
    });
  }
  return results;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:streams:verify");
    const results = await streamsVerify();
    log("lab:streams:verify");
    let failed = false;
    for (const result of results) {
      if (!result.exists) {
        failed = true;
        logError(`  ${result.stream}: does not exist (BREAKING_SCHEMA_DRIFT)`);
        continue;
      }
      log(
        `  ${result.stream}: settings_hash=${result.settingsHash} overall=${result.drift.overall}`,
      );
      if (result.drift.overall !== DRIFT_CLASS.NO_DRIFT) {
        failed = true;
        for (const finding of result.drift.findings) {
          logError(`    - ${finding.class}: ${JSON.stringify(finding.detail)}`);
        }
      }
      if (!result.pipelineFound) {
        log(
          `    (no sanitization pipeline found for ${result.stream} — pnpm lab:up provisions it)`,
        );
      }
    }
    process.exit(failed ? 1 : 0);
  } catch (error) {
    logError(`lab:streams:verify FAILED: ${error.message}`);
    process.exit(1);
  }
}
