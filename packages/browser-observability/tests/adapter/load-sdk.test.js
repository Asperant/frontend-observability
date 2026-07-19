import { describe, expect, it, vi } from "vitest";

const fakeOpenobserveRum = { init: vi.fn(), name: "fake-rum" };
const fakeOpenobserveLogs = { init: vi.fn(), name: "fake-logs" };

vi.mock("@openobserve/browser-rum", () => ({ openobserveRum: fakeOpenobserveRum }));
vi.mock("@openobserve/browser-logs", () => ({ openobserveLogs: fakeOpenobserveLogs }));

describe("loadOpenObserveSdk", () => {
  it("resolves the named rum/logs exports from the two real package specifiers", async () => {
    const { loadOpenObserveSdk } = await import("../../src/adapter/openobserve/load-sdk.js");
    const sdk = await loadOpenObserveSdk();
    expect(sdk.rum).toBe(fakeOpenobserveRum);
    expect(sdk.logs).toBe(fakeOpenobserveLogs);
  });

  it("returns a frozen object", async () => {
    const { loadOpenObserveSdk } = await import("../../src/adapter/openobserve/load-sdk.js");
    expect(Object.isFrozen(await loadOpenObserveSdk())).toBe(true);
  });
});
