import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import test from "node:test";
import { exitOf, finishChild, killed, waitForWork } from "./live-process.mjs";

function childFor(source) {
  return spawn(process.execPath, ["--input-type=module", "--eval", source], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {},
  });
}

test(
  "interruption reaches finally before an owned child ignoring SIGTERM gets the original ten-second shutdown",
  { timeout: 60_000 },
  async (t) => {
    const child = childFor(`
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    process.send({ event: "ready" });
  `);
    const exited = exitOf(child);
    t.after(async () => {
      killed(child, "SIGKILL");
      await exited;
    });
    await waitForWork(
      new Promise((accept) => {
        child.once("message", (message) => {
          if (message?.event === "ready") accept();
        });
      }),
      new AbortController().signal,
      { timeoutMs: 10_000 },
    );
    const interruption = new AbortController();
    let beganCleanup,
      result,
      interruptionObserved = false;
    const cleanupStarted = new Promise((accept) => {
      beganCleanup = accept;
    });
    const started = performance.now();
    const main = (async () => {
      try {
        await waitForWork(exited, interruption.signal);
      } catch (error) {
        assert.equal(error.message, "PORTAL_LIVE_INTERRUPTED");
        interruptionObserved = true;
      } finally {
        beganCleanup();
        result = await finishChild(child, exited, () => killed(child, "SIGTERM"));
      }
    })();
    interruption.abort();
    await cleanupStarted;
    assert.equal(interruptionObserved, true);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(getEventListeners(interruption.signal, "abort").length, 0);
    await main;
    const elapsed = performance.now() - started;
    assert.equal(result, false); // Forced exit never becomes confirmed graceful cleanup.
    assert.equal(child.signalCode, "SIGKILL");
    assert.ok(elapsed >= 9500);
    assert.ok(elapsed < 15_000); // Scheduling tolerance; the helper still arms exactly 10,000 ms.
  },
);

test(
  "aborting startup removes its sixty-second timer so the owned process exits naturally",
  { timeout: 60_000 },
  async (t) => {
    const helper = new URL("./live-process.mjs", import.meta.url).href;
    const child = childFor(`
    import { getEventListeners } from "node:events";
    import { waitForWork } from ${JSON.stringify(helper)};
    const controller = new AbortController();
    const waiting = waitForWork(new Promise(() => {}), controller.signal, { timeoutMs: 60000 });
    controller.abort();
    let interrupted = false;
    try { await waiting; } catch (error) { interrupted = error.message === "PORTAL_LIVE_INTERRUPTED"; }
    await new Promise((accept) => process.send({ interrupted, listeners: getEventListeners(controller.signal, "abort").length }, accept));
    process.disconnect();
  `);
    const exited = exitOf(child);
    t.after(async () => {
      killed(child, "SIGKILL");
      await exited;
    });
    let result;
    child.once("message", (message) => {
      result = message;
    });
    const exit = await waitForWork(exited, new AbortController().signal, { timeoutMs: 10_000 });
    assert.deepEqual(result, { interrupted: true, listeners: 0 });
    assert.equal(exit.code, 0);
    assert.equal(child.signalCode, null);
  },
);

test("already aborted and completed waits remove listeners without exposing the abort reason", async () => {
  const aborted = new AbortController();
  aborted.abort("PUBLIC-PORTAL-ERROR-SENTINEL");
  await assert.rejects(
    waitForWork(Promise.resolve("late"), aborted.signal, { timeoutMs: 60_000 }),
    /^Error: PORTAL_LIVE_INTERRUPTED$/,
  );
  assert.equal(getEventListeners(aborted.signal, "abort").length, 0);
  const finished = new AbortController();
  assert.equal(
    await waitForWork(Promise.resolve("ready"), finished.signal, { timeoutMs: 60_000 }),
    "ready",
  );
  assert.equal(getEventListeners(finished.signal, "abort").length, 0);
  finished.abort();
});
