import type { PrismaClient } from "@liyoxi/db";
import { describe, expect, it } from "vitest";

import {
  assertNotInTransaction,
  createTxRunner,
  detach,
  isInTransaction,
  KernelViolation,
} from "./tx.js";
import type { TxRunnerOptions } from "./tx.js";

// 这些用例只验真实 AsyncLocalStorage 的生命周期；提交/回滚另在 db 文件连真库验证。
const runner = (options: Partial<Omit<TxRunnerOptions, "prisma">> = {}) => {
  const client = { $queryRawUnsafe: async () => [] };
  const prisma = {
    $transaction: async (fn: (handle: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as PrismaClient;
  return createTxRunner({ prisma, appEnv: "test", ...options });
};

describe("detach：本异步链的作用域", () => {
  it("事务外可用、结果原样返回；不自行开事务", async () => {
    const value = { done: true };
    expect(
      await detach(async () => {
        await Promise.resolve();
        expect(isInTransaction()).toBe(false);
        assertNotInTransaction("outside");
        return value;
      }),
    ).toBe(value);
    expect(isInTransaction()).toBe(false);
  });

  it("成功、同步异常、异步异常均恢复外层，正常嵌套仍拒绝", async () => {
    const tx = runner();
    const boom = new Error("独立操作失败");
    await tx.run(async () => {
      expect(
        await detach(async () => {
          await Promise.resolve();
          expect(isInTransaction()).toBe(false);
          return 17;
        }),
      ).toBe(17);
      await expect(
        detach(() => {
          throw boom;
        }),
      ).rejects.toBe(boom);
      await expect(
        detach(async () => {
          await Promise.resolve();
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(isInTransaction()).toBe(true);
      await expect(tx.run(async () => null)).rejects.toMatchObject({ kind: "nested_transaction" });
    });
    expect(isInTransaction()).toBe(false);
  });

  it("取消也是普通失败，外层和事务外标记都恢复", async () => {
    const tx = runner();
    const cancelled = new Error("调用方取消");
    const controller = new AbortController();
    await tx.run(async () => {
      await expect(
        detach(async () => {
          await Promise.resolve();
          controller.abort(cancelled);
          controller.signal.throwIfAborted();
        }),
      ).rejects.toBe(cancelled);
      expect(isInTransaction()).toBe(true);
    });
    expect(isInTransaction()).toBe(false);
  });

  it("祖先事务存活时，脱离和再次脱离都不能绕过 Provider 外呼禁令", async () => {
    const tx = runner();
    await tx.run(async () => {
      await detach(async () => {
        expect(isInTransaction()).toBe(false);
        expect(() => assertNotInTransaction("sms.send")).toThrow(KernelViolation);
        await detach(async () => {
          await Promise.resolve();
          expect(() => assertNotInTransaction("storage.put")).toThrow(KernelViolation);
        });
        await tx.run(async () => {
          expect(isInTransaction()).toBe(true);
          expect(() => assertNotInTransaction("wechatPay.createOrder")).toThrow(KernelViolation);
          await expect(tx.run(async () => null)).rejects.toMatchObject({
            kind: "nested_transaction",
          });
        });
        expect(isInTransaction()).toBe(false);
      });
      expect(() => assertNotInTransaction("sms.send")).toThrow(KernelViolation);
    });
    assertNotInTransaction("sms.send");
  });

  it.each(["stg", "prod"] as const)("%s 的旧外呼违规报告策略保持", async (appEnv) => {
    const reported: KernelViolation[] = [];
    const tx = runner({ appEnv, report: (violation) => reported.push(violation) });
    await tx.run(() =>
      detach(async () => {
        assertNotInTransaction("sms.send");
      }),
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]?.kind).toBe("external_call_in_transaction");
  });
});
