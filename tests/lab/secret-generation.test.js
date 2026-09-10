import { describe, expect, it } from "vitest";

import { generateEmail, generatePassword } from "../../scripts/lab/generate-secrets.mjs";

describe("generatePassword", () => {
  it("is at least 32 bytes of entropy long and satisfies OpenObserve's character-class policy", () => {
    const password = generatePassword();
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[!@#$%^&*()\-_=+]/);
  });

  it("never repeats across generations", () => {
    const passwords = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(passwords.size).toBe(50);
  });
});

describe("generateEmail", () => {
  it("uses the reserved .invalid TLD so it can never resolve to a real mailbox", () => {
    expect(generateEmail()).toMatch(/^root-[a-z0-9]+@frontend-observability-lab\.invalid$/);
  });

  it("never repeats across generations", () => {
    const emails = new Set(Array.from({ length: 50 }, () => generateEmail()));
    expect(emails.size).toBe(50);
  });
});
