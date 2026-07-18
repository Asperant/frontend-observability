import { ACTION_NAME_PATTERN, MAX_ACTION_NAME_LENGTH } from "../internal/constants.js";

export function isValidActionName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_ACTION_NAME_LENGTH &&
    ACTION_NAME_PATTERN.test(name)
  );
}
