const MAX_MESSAGE_LENGTH = 512;
const MAX_STACK_LENGTH = 2048;
const MAX_NAME_LENGTH = 128;

/**
 * Normalizes any value passed to recordError() into a bounded, plain
 * object. Never throws, regardless of the shape of `error`.
 */
export function sanitizeError(error) {
  if (error instanceof Error) {
    return Object.freeze({
      name: typeof error.name === "string" ? error.name.slice(0, MAX_NAME_LENGTH) : "Error",
      message: typeof error.message === "string" ? error.message.slice(0, MAX_MESSAGE_LENGTH) : "",
      stack: typeof error.stack === "string" ? error.stack.slice(0, MAX_STACK_LENGTH) : undefined,
    });
  }

  if (typeof error === "string") {
    return Object.freeze({ name: "Error", message: error.slice(0, MAX_MESSAGE_LENGTH) });
  }

  return Object.freeze({
    name: "UnknownError",
    message: "A non-Error value was passed to recordError().",
  });
}
