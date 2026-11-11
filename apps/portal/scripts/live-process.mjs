// Lifecycle of the runner's own detached children only; no shell or arbitrary error forwarding.
const fail = () => new Error("PORTAL_LIVE_PROCESS_FAILED");

export function killed(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw fail();
  }
}

export function exitOf(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode });
  return new Promise((accept) => {
    child.once("error", () => accept({ code: null }));
    child.once("close", (code) => accept({ code }));
  });
}

/** Abort wakes the caller so its finally can actually reach the bounded child shutdown. */
export function waitForWork(work, signal, { timeoutMs } = {}) {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
  )
    throw fail();
  return new Promise((accept, reject) => {
    let settled = false,
      timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, new Error("PORTAL_LIVE_INTERRUPTED"));
    signal.addEventListener("abort", abort, { once: true });
    // Attach both handlers even when already aborted: a late rejected startup is still consumed.
    Promise.resolve(work).then(
      (value) => finish(accept, value),
      () => finish(reject, fail()),
    );
    if (signal.aborted) {
      abort();
      return;
    }
    if (timeoutMs !== undefined)
      timer = setTimeout(() => finish(reject, new Error("PORTAL_LIVE_WAIT_TIMEOUT")), timeoutMs);
  });
}

export async function finishChild(child, exited, stop) {
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return (await exited).code === 0;
  let timer;
  const overdue = new Promise((accept, reject) => {
    timer = setTimeout(() => {
      try {
        killed(child, "SIGKILL");
        void exited.then(
          () => accept(false),
          () => reject(fail()),
        );
      } catch {
        reject(fail());
      }
    }, 10_000);
  });
  try {
    stop();
    return await Promise.race([exited.then((result) => result.code === 0), overdue]);
  } finally {
    clearTimeout(timer);
  }
}
