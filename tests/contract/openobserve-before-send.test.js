import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const coreConfigSource = readFileSync(
  new URL(
    "../../node_modules/.pnpm/@openobserve+browser-core@0.3.4/node_modules/@openobserve/browser-core/src/domain/configuration/configuration.ts",
    import.meta.url,
  ),
  "utf8",
);

const rumAssemblySource = readFileSync(
  new URL(
    "../../node_modules/.pnpm/@openobserve+browser-rum-core@0.3.4/node_modules/@openobserve/browser-rum-core/src/domain/assembly.ts",
    import.meta.url,
  ),
  "utf8",
);

const actionNameSource = readFileSync(
  new URL(
    "../../node_modules/.pnpm/@openobserve+browser-rum-core@0.3.4/node_modules/@openobserve/browser-rum-core/src/domain/action/getActionNameFromElement.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("@openobserve/browser-rum 0.3.4 sanitization contracts", () => {
  it("supports beforeSend, telemetrySampleRate and trackAnonymousUser in the shared configuration", () => {
    expect(coreConfigSource).toContain("beforeSend?: GenericBeforeSendCallback");
    expect(coreConfigSource).toContain("telemetrySampleRate?: number");
    expect(coreConfigSource).toContain("trackAnonymousUser?: boolean");
  });

  it("allows RUM beforeSend to edit action.target.name and resource/error/view URLs", () => {
    expect(rumAssemblySource).toContain("'action.target.name': 'string'");
    expect(rumAssemblySource).toContain("'resource.url': 'string'");
    expect(rumAssemblySource).toContain("'error.message': 'string'");
    expect(rumAssemblySource).toContain("'error.stack': 'string'");
    expect(rumAssemblySource).toContain("'view.url': 'string'");
  });

  it("derives automatic action names from DOM text and attributes, so our beforeSend rewrite is mandatory", () => {
    expect(actionNameSource).toContain("innerText");
    expect(actionNameSource).toContain("aria-label");
    expect(actionNameSource).toContain("placeholder");
    expect(actionNameSource).toContain("input.value");
  });
});
