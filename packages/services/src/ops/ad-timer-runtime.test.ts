// Pure composition/lifetime tests only. The domain writer and database rollback have their own DB tests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assemble, defineRegistration } from "../kernel/index.js";
import type { FiredTimer, TimerHandlerRegistration, Tx } from "../kernel/index.js";
import type { handleAdReturnedStale, handleAdSlaBreach } from "../ad/index.js";
import { createAdAssembly } from "./ad-timer-runtime.js";
import type { AdTimerBinding } from "./ad-timer-runtime.js";

const domain = vi.hoisted(() => ({
  returned: vi.fn<typeof handleAdReturnedStale>(),
  sla: vi.fn<typeof handleAdSlaBreach>(),
}));
vi.mock("../ad/index.js", () => ({
  handleAdReturnedStale: domain.returned,
  handleAdSlaBreach: domain.sla,
  createAdFileGuard: () => ({ assert: async () => undefined }),
}));

const placeholder: TimerHandlerRegistration = {
  kind: "ad.returned_stale",
  critical: false,
  handle: async () => {
    throw new TypeError("unbound registration");
  },
};
const other: TimerHandlerRegistration = { kind: "lyxtest.other", handle: async () => "skipped" };
const base = () =>
  assemble({
    entry: "worker",
    appEnv: "test",
    registrations: [
      defineRegistration("lyxtest_ad_timer", {
        timerHandlers: [placeholder, other, { kind: "sla.breach", handle: async () => "skipped" }],
      }),
    ],
  });
const binding = (): AdTimerBinding => ({
  clock: { now: () => new Date("2026-01-05T04:00:00Z") },
  events: { emit: vi.fn<AdTimerBinding["events"]["emit"]>() },
});
// Opaque transport handle: this unit never queries a fake database or claims successful SQL rollback.
const tx = Object.freeze({}) as Tx;
const timer: FiredTimer = {
  id: "timer",
  kind: "ad.returned_stale",
  subjectType: "ad",
  subjectId: "ad",
  payload: null,
};
function handler(scope: ReturnType<typeof createAdAssembly>) {
  const value = scope.assembly.timerHandler("ad.returned_stale");
  if (!value) throw new Error("timer handler missing");
  return value.handle;
}
beforeEach(() => {
  domain.sla.mockReset();
  domain.sla.mockResolvedValue("fired");
  domain.returned.mockReset();
  domain.returned.mockResolvedValue("fired");
});

describe("广告定时器实例scope", () => {
  it("只替换唯一广告处理器，未绑定和已关闭都失败关闭", async () => {
    const original = base(),
      scope = createAdAssembly(original);
    expect(scope.assembly.timerHandlers.filter((item) => item.kind === timer.kind)).toHaveLength(1);
    expect(scope.assembly.timerHandler(timer.kind)?.critical).toBe(false);
    expect(scope.assembly.timerHandler(other.kind)).toBe(original.timerHandler(other.kind));
    expect(() => handler(scope)(tx, timer)).toThrow("尚未绑定");
    expect(domain.returned).not.toHaveBeenCalled();
    scope.attach(binding());
    await expect(handler(scope)(tx, timer)).resolves.toBe("fired");
    await scope.close();
    expect(() => handler(scope)(tx, timer)).toThrow("已经关闭");
    expect(() => scope.attach(binding())).toThrow("只能绑定一次");
    expect(domain.returned).toHaveBeenCalledTimes(1);
  });

  it("唯一 sla.breach 只路由广告，旧主体保留原处理器且关闭后广告失败", async () => {
    const scope = createAdAssembly(base());
    scope.attach(binding());
    const sla = scope.assembly.timerHandler("sla.breach")!.handle;
    await expect(
      sla(tx, { ...timer, kind: "sla.breach", subjectType: "delivery_ticket_stage" }),
    ).resolves.toBe("skipped");
    expect(domain.sla).not.toHaveBeenCalled();
    await expect(sla(tx, { ...timer, kind: "sla.breach" })).resolves.toBe("fired");
    expect(domain.sla).toHaveBeenCalledTimes(1);
    await scope.close();
    expect(() => sla(tx, { ...timer, kind: "sla.breach" })).toThrow("已经关闭");
  });

  it("两个实例各自委派自己的依赖，关闭A不污染B", async () => {
    const original = base(),
      a = createAdAssembly(original),
      b = createAdAssembly(original);
    const depsA = binding(),
      depsB = binding();
    a.attach(depsA);
    b.attach(depsB);
    expect(() => a.attach(depsB)).toThrow("只能绑定一次");
    await handler(a)(tx, timer);
    await handler(b)(tx, timer);
    expect(domain.returned.mock.calls[0]).toEqual([tx, depsA, timer]);
    expect(domain.returned.mock.calls[1]).toEqual([tx, depsB, timer]);
    await a.close();
    await expect(handler(b)(tx, timer)).resolves.toBe("fired");
    expect(() => handler(a)(tx, timer)).toThrow("已经关闭");
    await b.close();
  });

  it("关闭等待已准入domain完成，await后拒绝旧TX提交信号且close幂等", async () => {
    const scope = createAdAssembly(base());
    scope.attach(binding());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    domain.returned.mockImplementationOnce(async () => {
      await barrier;
      return "fired";
    });
    const active = handler(scope)(tx, timer);
    const rejected = expect(active).rejects.toThrow("已经关闭");
    let drained = false;
    const closing = scope.close();
    expect(scope.close()).toBe(closing);
    void closing.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(() => handler(scope)(tx, timer)).toThrow("已经关闭");
    release();
    await rejected;
    await closing;
    expect(drained).toBe(true);
  });

  it("domain错误原样传播后可排空，缺失或重复登记拒绝装配", async () => {
    const original = base(),
      scope = createAdAssembly(original);
    scope.attach(binding());
    const failure = new Error("domain failed");
    domain.returned.mockRejectedValueOnce(failure);
    await expect(handler(scope)(tx, timer)).rejects.toBe(failure);
    await scope.close();
    expect(() => createAdAssembly({ ...original, timerHandlers: [] })).toThrow("唯一");
    expect(() =>
      createAdAssembly({
        ...original,
        timerHandlers: [...original.timerHandlers, original.timerHandlers[0]!],
      }),
    ).toThrow("唯一");
  });
});
