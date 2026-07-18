import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import runtimeConfigSchema from "../schemas/runtime-config.schema.json" with { type: "json" };
import customActionSchema from "../schemas/custom-action.schema.json" with { type: "json" };
import diagnosticEventSchema from "../schemas/diagnostic-event.schema.json" with { type: "json" };

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats(ajv);

const compiledValidators = {
  runtimeConfig: ajv.compile(runtimeConfigSchema),
  customAction: ajv.compile(customActionSchema),
  diagnosticEvent: ajv.compile(diagnosticEventSchema),
};

function formatErrors(errors) {
  if (!errors) return [];
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`);
}

/**
 * Runs an Ajv validator without ever throwing, so a malformed payload can
 * never surface as an uncaught exception in a host application.
 */
function runValidator(validatorKey, data) {
  try {
    const validate = compiledValidators[validatorKey];
    const valid = validate(data);
    return { valid, errors: valid ? [] : formatErrors(validate.errors) };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function validateRuntimeConfig(data) {
  return runValidator("runtimeConfig", data);
}

export function validateCustomAction(data) {
  return runValidator("customAction", data);
}

export function validateDiagnosticEvent(data) {
  return runValidator("diagnosticEvent", data);
}
