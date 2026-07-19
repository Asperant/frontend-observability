import { describe, expect, it } from "vitest";

import { mapAction } from "../../src/adapter/openobserve/map-action.js";

describe("mapAction", () => {
  it("passes the name through and bounds/sanitizes attributes", () => {
    const result = mapAction("checkout.submit", { itemCount: 3, label: "ok" });
    expect(result.name).toBe("checkout.submit");
    expect(result.context).toEqual({ itemCount: 3, label: "ok" });
  });

  it("drops unsafe attribute values instead of forwarding them to the SDK", () => {
    const result = mapAction("checkout.submit", {
      valid: "x",
      nested: { a: 1 },
      fn: () => {},
      sym: Symbol("x"),
    });
    expect(result.context).toEqual({ valid: "x" });
  });

  it("defaults attributes to an empty object", () => {
    expect(mapAction("checkout.submit", undefined).context).toEqual({});
    expect(mapAction("checkout.submit", null).context).toEqual({});
  });

  it("returns a frozen result", () => {
    const result = mapAction("checkout.submit", {});
    expect(Object.isFrozen(result)).toBe(true);
  });
});
