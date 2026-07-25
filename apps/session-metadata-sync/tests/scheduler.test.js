// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createTickScheduler } from "../src/scheduler.js";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createTickScheduler", () => {
  it("does not start a new sync while one is already in flight", async () => {
    const first = deferred();
    const runSyncOnce = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const scheduler = createTickScheduler(runSyncOnce);

    const inFlight = scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(runSyncOnce).toHaveBeenCalledTimes(1);
    first.resolve();
    await inFlight;
  });

  it("allows the next tick to run once the previous sync has completed", async () => {
    const runSyncOnce = vi.fn().mockResolvedValue(undefined);
    const scheduler = createTickScheduler(runSyncOnce);

    await scheduler.tick();
    await scheduler.tick();

    expect(runSyncOnce).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight guard even when the sync rejects", async () => {
    const runSyncOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const scheduler = createTickScheduler(runSyncOnce);

    await scheduler.tick();
    await scheduler.tick();

    expect(runSyncOnce).toHaveBeenCalledTimes(2);
  });

  it("does not start new ticks once stopped", async () => {
    const runSyncOnce = vi.fn().mockResolvedValue(undefined);
    const scheduler = createTickScheduler(runSyncOnce);

    scheduler.stop();
    await scheduler.tick();

    expect(runSyncOnce).not.toHaveBeenCalled();
  });

  it("does not run a tick that starts after stop(), even if already in flight", async () => {
    const first = deferred();
    const runSyncOnce = vi.fn().mockReturnValueOnce(first.promise);
    const scheduler = createTickScheduler(runSyncOnce);

    const inFlight = scheduler.tick();
    scheduler.stop();
    first.resolve();
    await inFlight;

    await scheduler.tick();
    expect(runSyncOnce).toHaveBeenCalledTimes(1);
  });
});
