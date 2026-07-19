import { describe, expect, it } from "vitest";

import {
  ControlReasonCodes,
  validateControlDocumentShape,
  validateControlLifetime,
} from "../../src/runtime-control/validate-document.js";

function validDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    issuedAt: "2026-07-19T19:00:00.000Z",
    expiresAt: "2026-07-19T19:05:00.000Z",
    killSwitch: { active: false, reasonCode: "none" },
    ...overrides,
  };
}

describe("validateControlDocumentShape", () => {
  it("accepts a well-formed document", () => {
    expect(validateControlDocumentShape(validDoc()).valid).toBe(true);
  });

  it("accepts every documented killSwitch.reasonCode", () => {
    for (const reasonCode of [
      "none",
      "security_incident",
      "privacy_incident",
      "service_degradation",
      "maintenance",
      "operator_request",
    ]) {
      expect(
        validateControlDocumentShape(
          validDoc({ killSwitch: { active: reasonCode !== "none", reasonCode } }),
        ).valid,
      ).toBe(true);
    }
  });

  it("rejects a non-object document", () => {
    expect(validateControlDocumentShape(null).valid).toBe(false);
    expect(validateControlDocumentShape([]).valid).toBe(false);
    expect(validateControlDocumentShape("x").valid).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    const result = validateControlDocumentShape({ ...validDoc(), extra: true });
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe(ControlReasonCodes.UNKNOWN_KEY);
  });

  it("rejects an unknown killSwitch key", () => {
    const result = validateControlDocumentShape(
      validDoc({ killSwitch: { active: false, reasonCode: "none", note: "x" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe(ControlReasonCodes.UNKNOWN_KEY);
  });

  it("rejects a schemaVersion other than the literal 1", () => {
    expect(validateControlDocumentShape(validDoc({ schemaVersion: 2 })).valid).toBe(false);
    expect(validateControlDocumentShape(validDoc({ schemaVersion: "1" })).valid).toBe(false);
  });

  it("rejects a non-integer or negative revision", () => {
    expect(validateControlDocumentShape(validDoc({ revision: -1 })).valid).toBe(false);
    expect(validateControlDocumentShape(validDoc({ revision: 1.5 })).valid).toBe(false);
    expect(validateControlDocumentShape(validDoc({ revision: "1" })).valid).toBe(false);
    expect(validateControlDocumentShape(validDoc({ revision: 0 })).valid).toBe(true);
  });

  it("rejects a non-boolean killSwitch.active", () => {
    expect(
      validateControlDocumentShape(validDoc({ killSwitch: { active: "true", reasonCode: "none" } }))
        .valid,
    ).toBe(false);
  });

  it("rejects a killSwitch.reasonCode outside the closed enum", () => {
    expect(
      validateControlDocumentShape(
        validDoc({ killSwitch: { active: false, reasonCode: "because" } }),
      ).valid,
    ).toBe(false);
  });

  it("rejects free-text-looking values smuggled into reasonCode", () => {
    expect(
      validateControlDocumentShape(
        validDoc({ killSwitch: { active: true, reasonCode: "revoked due to token leak" } }),
      ).valid,
    ).toBe(false);
  });
});

describe("validateControlLifetime", () => {
  const now = new Date("2026-07-19T19:02:00.000Z");

  it("accepts a live document within the TTL bound", () => {
    expect(validateControlLifetime(validDoc(), now).valid).toBe(true);
  });

  it("rejects expiresAt <= issuedAt", () => {
    const result = validateControlLifetime(
      validDoc({ issuedAt: "2026-07-19T19:05:00.000Z", expiresAt: "2026-07-19T19:00:00.000Z" }),
      now,
    );
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe(ControlReasonCodes.LIFETIME_INVALID);
  });

  it("rejects a TTL over 10 minutes", () => {
    const result = validateControlLifetime(
      validDoc({ issuedAt: "2026-07-19T19:00:00.000Z", expiresAt: "2026-07-19T19:10:01.000Z" }),
      now,
    );
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe(ControlReasonCodes.TTL_EXCEEDED);
  });

  it("accepts a TTL of exactly 10 minutes", () => {
    const result = validateControlLifetime(
      validDoc({ issuedAt: "2026-07-19T19:00:00.000Z", expiresAt: "2026-07-19T19:10:00.000Z" }),
      now,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects an issuedAt further in the future than the bounded clock-skew tolerance", () => {
    const result = validateControlLifetime(
      validDoc({ issuedAt: "2026-07-19T19:05:00.000Z", expiresAt: "2026-07-19T19:09:00.000Z" }),
      now,
    );
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe(ControlReasonCodes.NOT_YET_VALID);
  });

  it("accepts a small, bounded future issuedAt within the clock-skew tolerance", () => {
    const result = validateControlLifetime(
      validDoc({ issuedAt: "2026-07-19T19:02:30.000Z", expiresAt: "2026-07-19T19:07:30.000Z" }),
      now,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a document that has already expired by arrival time", () => {
    const result = validateControlLifetime(
      validDoc({ issuedAt: "2026-07-19T18:50:00.000Z", expiresAt: "2026-07-19T18:55:00.000Z" }),
      now,
    );
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe(ControlReasonCodes.EXPIRED);
  });

  it("rejects unparseable timestamps", () => {
    const result = validateControlLifetime(validDoc({ issuedAt: "not-a-date" }), now);
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe(ControlReasonCodes.LIFETIME_INVALID);
  });
});
