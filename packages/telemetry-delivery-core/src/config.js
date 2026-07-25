import { readFileSync } from "node:fs";

export function readSecret(path) {
  return readFileSync(path, "utf8").trim();
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid integer environment variable: ${name}`);
  }
  return parsed;
}
