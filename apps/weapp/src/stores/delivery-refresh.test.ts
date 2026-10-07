import { describe, expect, it } from "vitest";
import { createDeliveryGuard } from "./delivery";

const guard = () =>
  createDeliveryGuard(
    () => "same-owner-store-and-token",
    () => "intent",
  );

describe("同门店刷新与操作生命期", () => {
  it("新版第一页保留，迟到分页和写后GET都不得回写", () => {
    for (const lateResult of ["old first + delayed next", "old version after mutation"]) {
      const g = guard();
      g.nextRead();
      const operation = g.begin()!;
      let displayed = "old first";
      g.invalidate();
      const fresh = g.nextRead();
      if (fresh()) displayed = "new first";
      if (operation()) displayed = lateResult;
      expect(displayed).toBe("new first");
      expect(operation()).toBe(false);
    }
  });

  it("刷新后的迟到错误不回写，原操作完成仍能解除busy并继续新操作", async () => {
    const g = guard();
    g.nextRead();
    const operation = g.begin()!;
    let busy = true;
    let error: string | null = null;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const completed = pending
      .catch((e: Error) => {
        if (operation()) error = e.message;
      })
      .finally(() => {
        if (g.finish(operation)) busy = false;
      });
    g.invalidate();
    g.nextRead();
    expect(g.begin()).toBeNull();
    reject(new Error("delayed failure"));
    await completed;
    expect(error).toBeNull();
    expect(busy).toBe(false);
    const next = g.begin()!;
    expect(next()).toBe(true);
    expect(g.finish(next)).toBe(true);
  });

  it("旧finally不能释放新操作锁，卸载操作只释放锁而不回写忙态", () => {
    const g = guard();
    const old = g.begin()!;
    g.invalidate();
    expect(g.finish(old)).toBe(true);
    const next = g.begin()!;
    expect(g.finish(old)).toBe(false);
    expect(g.begin()).toBeNull();
    expect(next()).toBe(true);
    g.dispose();
    expect(next()).toBe(false);
    expect(g.finish(next)).toBe(false);
    g.mount();
    expect(g.begin()).not.toBeNull();
  });
});
