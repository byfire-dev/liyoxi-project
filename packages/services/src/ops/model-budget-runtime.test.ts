import { describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import type { AlertInput } from "../kernel/index.js";
import type { ModelBudgetContext } from "../media/index.js";
import { createClock } from "../testing/index.js";
import { createModelBudgetRuntime } from "./model-budget-runtime.js";

// 这里只验证实例生命周期和协议替身；真实PG/Redis证据在相邻DB整叶。
function setup(reply: unknown = ["reserved", 3, 1]) {
  const clock = createClock(new Date());
  const evalCall = vi.fn(async () => reply);
  const raise = vi.fn(async (_fact: AlertInput) => undefined);
  const warn = vi.fn();
  const runtime = createModelBudgetRuntime({
    clock,
    prefix: "lyx:test:runtime:",
    transport: { eval: evalCall },
    alerts: { raise },
    logger: { info: vi.fn(), warn, error: vi.fn() },
  });
  function context(): ModelBudgetContext {
    const at = clock.now().getTime();
    return {
      entityId: uuidv7(),
      storeId: uuidv7(),
      jobId: uuidv7(),
      fileIds: [uuidv7()],
      kind: "vision",
      attemptNo: 1,
      expectedSourceHash: "a".repeat(64),
      dailyFileCap: 200,
      dailyCallCap: 10000,
      readAtMs: at,
      admitUntilMs: at + 250,
      leaseUntilMs: at + 60000,
      originalDeadlineMs: at + 60000,
    };
  }
  return { clock, evalCall, raise, warn, runtime, context };
}

describe("模型预算实例生命周期（纯协议替身）", () => {
  it("构造零IO，真实ledger公口只转发一次且不拥有transport", async () => {
    const h = setup();
    expect(h.evalCall).not.toHaveBeenCalled();
    expect(h.raise).not.toHaveBeenCalled();
    const value = h.context();
    expect(await h.runtime.admission.reserve(value, new AbortController().signal)).toEqual({
      status: "reserved",
      units: 3,
      newFiles: 1,
    });
    expect(h.evalCall).toHaveBeenCalledOnce();
    const call = h.evalCall.mock.calls[0] as unknown as [string, string[], string[]];
    expect(call[0]).toContain("redis.call('TIME')");
    expect(call[1]).toEqual(["lyx:test:runtime:model_budget:v1"]);
    expect(call[2]).toContain(value.jobId);
    expect(h.raise).not.toHaveBeenCalled();
    await h.runtime.close();
  });

  it.each(["quota_global", "quota_store", "unavailable"] as const)(
    "%s只产生受控事实且维度不包含正文/URL/hash",
    async (reason) => {
      const h = setup(["denied", reason]),
        value = h.context();
      expect(await h.runtime.admission.reserve(value, new AbortController().signal)).toEqual({
        status: "denied",
        reason,
      });
      expect(h.raise).toHaveBeenCalledExactlyOnceWith({
        rule:
          reason === "unavailable"
            ? "media.model_budget_unavailable"
            : "media.model_budget_exhausted",
        dimension: reason === "quota_store" ? value.storeId : "global",
        severity: "P2",
        detail: { kind: "vision", reason, scope: reason === "quota_store" ? "store" : "global" },
      });
      expect(JSON.stringify(h.raise.mock.calls)).not.toContain(value.expectedSourceHash);
      await h.runtime.close();
    },
  );

  it.each(["disabled", "duplicate", "stale"] as const)("%s不误报超限", async (reason) => {
    const h = setup(["denied", reason]);
    expect(await h.runtime.admission.reserve(h.context(), new AbortController().signal)).toEqual({
      status: "denied",
      reason,
    });
    expect(h.raise).not.toHaveBeenCalled();
    await h.runtime.close();
  });

  it("缺transport明确关闭，不自动建账", async () => {
    const h = setup();
    const one = createModelBudgetRuntime({
      clock: h.clock,
      prefix: "lyx:test:",
      alerts: { raise: h.raise },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(await one.admission.reserve(h.context(), new AbortController().signal)).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(h.evalCall).not.toHaveBeenCalled();
    expect(h.raise.mock.calls[0]?.[0].rule).toBe("media.model_budget_unavailable");
    await one.close();
  });

  it.each(["resolve", "reject"] as const)("close取消在途R并消化迟到%s", async (late) => {
    const h = setup();
    let release!: (value: unknown) => void, reject!: (reason: unknown) => void;
    let entered!: () => void;
    const entry = new Promise<void>((r) => {
      entered = r;
    });
    h.evalCall.mockImplementation(() => {
      entered();
      return new Promise((yes, no) => {
        release = yes;
        reject = no;
      });
    });
    const pending = h.runtime.admission.reserve(h.context(), new AbortController().signal);
    await entry;
    const closing = h.runtime.close();
    expect(h.runtime.close()).toBe(closing);
    await closing;
    expect(await pending).toEqual({ status: "denied", reason: "unavailable" });
    if (late === "resolve") release(["reserved", 3, 1]);
    else reject(new Error("公开虚构迟到异常"));
    await Promise.resolve();
    expect(await h.runtime.maintain()).toEqual({ status: "denied", reason: "unavailable" });
    expect(await h.runtime.admission.reserve(h.context(), new AbortController().signal)).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(h.evalCall).toHaveBeenCalledOnce();
  });

  it("外部signal原取消有效，预取消零EVAL", async () => {
    const h = setup(),
      controller = new AbortController();
    controller.abort();
    expect(await h.runtime.admission.reserve(h.context(), controller.signal)).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(h.evalCall).not.toHaveBeenCalled();
    await h.runtime.close();
  });

  it("维护同轮只执行一次，close后不再发维护", async () => {
    const h = setup();
    let release!: (value: unknown) => void;
    h.evalCall.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const first = h.runtime.maintain(),
      second = h.runtime.maintain();
    expect(second).toBe(first);
    await Promise.resolve();
    release(["maintained", 128, 2]);
    expect(await first).toEqual({ status: "maintained", scanned: 128, removed: 2 });
    expect(h.evalCall).toHaveBeenCalledOnce();
    await h.runtime.close();
    await h.runtime.maintain();
    expect(h.evalCall).toHaveBeenCalledOnce();
  });

  it("告警口与logger同时抛错不替换原denial", async () => {
    const h = setup(["denied", "quota_global"]);
    h.raise.mockRejectedValue(new Error("公开虚构告警故障"));
    h.warn.mockImplementation(() => {
      throw new Error("公开虚构日志故障");
    });
    expect(await h.runtime.admission.reserve(h.context(), new AbortController().signal)).toEqual({
      status: "denied",
      reason: "quota_global",
    });
    await expect(h.runtime.close()).resolves.toBeUndefined();
  });

  it("两个实例关闭隔离，借用transport不被quit/disconnect", async () => {
    const h = setup(),
      quit = vi.fn(),
      disconnect = vi.fn();
    const borrowed = { eval: h.evalCall, quit, disconnect };
    const other = createModelBudgetRuntime({
      clock: h.clock,
      prefix: "lyx:test:other:",
      transport: borrowed,
      alerts: { raise: h.raise },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await h.runtime.close();
    expect(await other.admission.reserve(h.context(), new AbortController().signal)).toMatchObject({
      status: "reserved",
    });
    await other.close();
    expect(quit).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("告警队列最多64项，故障突发不会无限延长一次drain", async () => {
    const h = setup(["denied", "quota_store"]);
    let release!: () => void, entered!: () => void;
    const entry = new Promise<void>((r) => {
      entered = r;
    });
    h.raise.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((r) => {
        release = r;
      });
    });
    const first = h.runtime.admission.reserve(h.context(), new AbortController().signal);
    await entry;
    const rest = Array.from({ length: 65 }, () =>
      h.runtime.admission.reserve(h.context(), new AbortController().signal),
    );
    try {
      await vi.waitFor(() =>
        expect(h.warn).toHaveBeenCalledWith(
          { evt: "media.model_budget_alert_overflow" },
          expect.any(String),
        ),
      );
      release();
      await Promise.all([first, ...rest]);
      await h.runtime.close();
      expect(h.raise).toHaveBeenCalledTimes(65);
      expect(h.warn).toHaveBeenCalledWith(
        { evt: "media.model_budget_alert_overflow" },
        expect.any(String),
      );
    } finally {
      release();
      await Promise.allSettled([first, ...rest]);
      await h.runtime.close();
    }
  });
});
