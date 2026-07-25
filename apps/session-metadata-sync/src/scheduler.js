export function createTickScheduler(runSyncOnce) {
  let syncing = false;
  let shuttingDown = false;

  async function tick() {
    if (syncing || shuttingDown) return;
    syncing = true;
    try {
      await runSyncOnce();
    } catch {
      // The sync service already records a bounded lastErrorCode on its own
      // state; readiness is derived from that state, not from this catch.
    } finally {
      syncing = false;
    }
  }

  function stop() {
    shuttingDown = true;
  }

  return { tick, stop };
}
