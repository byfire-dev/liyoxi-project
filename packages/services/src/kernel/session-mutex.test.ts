import type { SessionMutexConnectionFactory } from "@liyoxi/db";
import { describe, expect, it, vi } from "vitest";
import { createSessionMutex } from "./session-mutex.js";
import type { SessionMutexScope } from "./session-mutex.js";

function gate() {
  let open!: () => void;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done, open };
}
/** 只替代物理连接；公开作用域、ALS与生命周期始终是真实kernel代码。 */
function connections() {
  const held = new Map<bigint, object>();
  let closes = 0;
  const connect: SessionMutexConnectionFactory = vi.fn(async (signal) => {
    const owner = {},
      lost = new AbortController();
    let key: bigint | undefined;
    const release = () => {
      if (key !== undefined && held.get(key) === owner) held.delete(key);
    };
    const abort = () => {
      release();
      lost.abort(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    return {
      lost: lost.signal,
      async tryLock(value) {
        if (held.has(value)) return false;
        key = value;
        held.set(value, owner);
        return true;
      },
      async isHeld() {
        return key !== undefined && held.get(key) === owner;
      },
      async close() {
        signal.removeEventListener("abort", abort);
        release();
        closes++;
      },
    };
  });
  return { connect, held, closes: () => closes };
}

describe("SessionMutex公开作用域性质", () => {
  it("作用域不出裸连接、不能跨兄弟链复用或嵌套，非法键不建立连接", async () => {
    const driver = connections(),
      mutex = createSessionMutex({ connect: driver.connect });
    const ready = gate(),
      release = gate();
    let captured: SessionMutexScope | undefined;
    try {
      await expect(mutex.run("", async () => undefined)).rejects.toBeInstanceOf(RangeError);
      await expect(mutex.run("x".repeat(201), async () => undefined)).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(driver.connect).not.toHaveBeenCalled();
      const running = mutex.run("unit:scope", async (scope) => {
        captured = scope;
        expect(Object.keys(scope)).toEqual(["signal", "assertHeld"]);
        expect(scope.signal.aborted).toBe(false);
        await scope.assertHeld();
        await expect(mutex.run("unit:nested", async () => undefined)).rejects.toThrow("不能嵌套");
        ready.open();
        await release.done;
        await scope.assertHeld();
        return 17;
      });
      await ready.done;
      await expect(captured!.assertHeld()).rejects.toThrow("不能跨异步链");
      expect(() => captured!.signal).toThrow("不能跨异步链");
      release.open();
      expect(await running).toBe(17);
      expect(driver.held.size).toBe(0);
      expect(driver.closes()).toBe(1);
    } finally {
      release.open();
      await mutex.close();
    }
  });

  it("关闭拒新/幂等并排空不合作回调；连接建立失败释放容量且保留原异常", async () => {
    const driver = connections(),
      mutex = createSessionMutex({ connect: driver.connect, maxConcurrent: 1 });
    const ready = gate(),
      release = gate();
    let signal: AbortSignal | undefined,
      drained = false,
      closed = false;
    const running = mutex.run("unit:close", async (scope) => {
      signal = scope.signal;
      ready.open();
      await release.done;
      drained = true;
    });
    const rejected = expect(running).rejects.toMatchObject({ reason: "closed" });
    await ready.done;
    await expect(mutex.run("unit:capacity", async () => undefined)).rejects.toMatchObject({
      reason: "capacity",
    });
    const closing = mutex.close();
    void closing.then(() => {
      closed = true;
    });
    expect(mutex.close()).toBe(closing);
    expect(signal!.aborted).toBe(true);
    await expect(mutex.run("unit:new", async () => undefined)).rejects.toMatchObject({
      reason: "closed",
    });
    await rejected;
    expect(closed).toBe(false);
    expect(drained).toBe(false);
    release.open();
    await closing;
    expect(drained).toBe(true);
    expect(driver.closes()).toBe(1);
    const boom = new Error("lyxtest mutex connect failed");
    let first = true;
    const recovering = createSessionMutex({
      maxConcurrent: 1,
      connect: async (input) => {
        if (first) {
          first = false;
          throw boom;
        }
        return driver.connect(input);
      },
    });
    try {
      await expect(recovering.run("unit:retry", async () => 1)).rejects.toBe(boom);
      expect(await recovering.run("unit:retry", async () => 2)).toBe(2);
    } finally {
      await recovering.close();
    }
  });
});
