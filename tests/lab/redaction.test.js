import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../scripts/lab/common.mjs";

describe("redactSecrets", () => {
  it("replaces every occurrence of a secret value with a fixed placeholder", () => {
    const text = "email=root@lab.invalid password=Sup3r!Secret\nlogin failed for root@lab.invalid";
    const redacted = redactSecrets(text, ["root@lab.invalid", "Sup3r!Secret"]);
    expect(redacted).not.toContain("root@lab.invalid");
    expect(redacted).not.toContain("Sup3r!Secret");
    expect(redacted).toContain("[redacted]");
  });

  it("ignores empty/undefined secret values instead of corrupting the text", () => {
    const text = "hello world";
    expect(redactSecrets(text, ["", undefined, null])).toBe("hello world");
  });

  it("leaves text with no secret occurrences unchanged", () => {
    const text = "nothing sensitive here";
    expect(redactSecrets(text, ["some-secret"])).toBe(text);
  });
});
