import { describe, expect, it } from "vitest";

import { CallInterruptedError, samplePrepay } from "../../testing/index.js";
import { AppError } from "../errors.js";
import { createIdempotencyContext, IDEMPOTENCY_LEASE_MS } from "../idempotency.js";
import { KernelViolation } from "../tx.js";
import { attemptOf, SLOW, useThreePhase } from "./__fixtures__/harness.js";

// 验收第 4、6、8 条：三种形态各一条样例；“先落库”外呼失败执行补偿；“多事务”已提交的技术状态不回滚；
// 同键不同内容 IDEMPOTENCY_KEY_REUSED；幂等为 none 的三段式不读写幂等记录。

const h = useThreePhase();

const rejects = (attempt: Promise<unknown>, error: string): Promise<void> =>
  expect(attempt).rejects.toMatchObject({ name: "AppError", error });

describe("三段式：三种形态（验收 4）", () => {
  it(
    "先调外部、再开事务：没有 claim；外呼之后一个事务落结果并写幂等记录",
    async () => {
      const attempt = attemptOf("ef");
      const { result, idem } = await h.send("external_first", attempt);
      expect(idem).toMatchObject({ used: true, replayed: false });
      expect(h.calls(attempt.no)).toBe(1);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", lockedUntil: null, result });
    },
    SLOW,
  );

  it(
    "先落库、提交后外调：外呼时本地行已提交；成功后按结果更新",
    async () => {
      const attempt = attemptOf("lf");
      const seen: unknown[] = [];
      const useCase = samplePrepay(
        "local_first",
        {
          wechatPay: h.wechatPay,
          // 外呼的那一刻从另一条连接看：本地行已经提交，占用也已经提交
          call: async (external) => {
            seen.push(await h.row(attempt.no), (await h.idemRow(attempt))?.state);
            return external();
          },
        },
        { outTradeNo: attempt.no, amountFen: 100, payerOpenid: "o-sample" },
      );
      const result = await h.threePhase.run(useCase, { idem: h.request(attempt) });
      expect(seen).toEqual([
        { outTradeNo: attempt.no, status: "pending", prepayId: null, settled: 0 },
        "in_progress",
      ]);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", result });
    },
    SLOW,
  );

  it(
    "先落库：外呼失败执行声明的补偿（删行），不留占用；同键直接重试成功",
    async () => {
      const attempt = attemptOf("lf-fail");
      h.wechatPay.failNext("createJsapiOrder");
      await rejects(h.send("local_first", attempt), "PROVIDER_UNAVAILABLE");
      expect(await h.row(attempt.no)).toBeUndefined();
      expect(await h.idemRow(attempt)).toBeNull();

      const { idem } = await h.send("local_first", attempt);
      expect(idem.replayed).toBe(false);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
    },
    SLOW,
  );

  it(
    "多事务：外部拒绝时，事务一已提交的技术状态不回滚（标成 closed 留着），幂等记录不留",
    async () => {
      const attempt = attemptOf("mt-fail");
      h.wechatPay.failNext("createJsapiOrder", { reason: "rejected", message: "订单已关闭" });
      await rejects(h.send("multi_tx", attempt), "STATE_NOT_ALLOWED");
      expect(await h.row(attempt.no)).toEqual({
        outTradeNo: attempt.no,
        status: "closed",
        prepayId: null,
        settled: 0,
      });
      expect(await h.idemRow(attempt)).toBeNull();
    },
    SLOW,
  );

  it(
    "多事务：落结果时守卫不过（settle 抛业务错误），末个事务回滚、事务一的行留着，补偿收到是哪一段失败的",
    async () => {
      const attempt = attemptOf("mt-settle");
      const closed = new AppError("STATE_NOT_ALLOWED", { message: "付款单已关闭" });
      const failures: unknown[] = [];
      const base = samplePrepay(
        "multi_tx",
        { wechatPay: h.wechatPay },
        { outTradeNo: attempt.no, amountFen: 100, payerOpenid: "o-sample" },
      );
      const run = h.threePhase.run(
        {
          ...base,
          settle: async (tx, outcome, intent) => {
            await base.settle(tx, outcome, intent); // 写了一半，随末个事务回滚
            throw closed;
          },
          compensate: async (tx, intent, failure) => {
            failures.push(failure);
            await base.compensate?.(tx, intent, failure);
          },
        },
        { idem: h.request(attempt) },
      );
      await expect(run).rejects.toBe(closed);
      expect(failures).toEqual([{ error: closed, phase: "settle" }]);
      expect(await h.row(attempt.no)).toMatchObject({
        status: "closed",
        prepayId: null,
        settled: 0,
      });
      expect(await h.idemRow(attempt)).toBeNull();
    },
    SLOW,
  );

  it(
    "claim 里抛错：事务一整个回滚，意图与占用都不留，不外呼",
    async () => {
      const attempt = attemptOf("claim-fail");
      const base = samplePrepay(
        "local_first",
        { wechatPay: h.wechatPay },
        { outTradeNo: attempt.no, amountFen: 100, payerOpenid: "o-sample" },
      );
      const run = h.threePhase.run(
        {
          ...base,
          claim: async (tx, claim) => {
            await base.claim?.(tx, claim);
            throw new AppError("STATE_NOT_ALLOWED");
          },
        },
        { idem: h.request(attempt) },
      );
      await rejects(run, "STATE_NOT_ALLOWED");
      expect(await h.row(attempt.no)).toBeUndefined();
      expect(await h.idemRow(attempt)).toBeNull();
      expect(h.calls(attempt.no)).toBe(0);
    },
    SLOW,
  );

  it(
    "续做时 claim 再执行一遍，resumed 为真；首次为假",
    async () => {
      const attempt = attemptOf("resumed");
      const seen: boolean[] = [];
      const send = () => {
        const base = samplePrepay(
          "multi_tx",
          { wechatPay: h.wechatPay, call: h.interrupter.call },
          { outTradeNo: attempt.no, amountFen: 100, payerOpenid: "o-sample" },
        );
        return h.threePhase.run(
          {
            ...base,
            claim: async (tx, claim) => {
              seen.push(claim.resumed);
              return base.claim?.(tx, claim);
            },
          },
          { idem: h.request(attempt) },
        );
      };
      h.interrupter.arm("before");
      await expect(send()).rejects.toBeInstanceOf(CallInterruptedError);
      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      await send();
      expect(seen).toEqual([false, true]);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
    },
    SLOW,
  );
});

describe("三段式：键被改用（验收 6）", () => {
  it(
    "同键不同请求内容：IDEMPOTENCY_KEY_REUSED，不占用、不外呼（已完成的键、占用中的键都一样）",
    async () => {
      const done = attemptOf("reuse-done");
      await h.send("multi_tx", done);
      const occupied = attemptOf("reuse-busy");
      h.interrupter.arm("before");
      await expect(h.send("multi_tx", occupied)).rejects.toBeInstanceOf(CallInterruptedError);
      h.clock.advance(IDEMPOTENCY_LEASE_MS); // 占用过期了也不让换内容的请求抢

      for (const attempt of [done, occupied]) {
        const before = { idem: await h.idemRow(attempt), row: await h.row(attempt.no) };
        const calls = h.wechatPay.calls.length;
        await rejects(h.send("multi_tx", { ...attempt, amountFen: 999 }), "IDEMPOTENCY_KEY_REUSED");
        expect({ idem: await h.idemRow(attempt), row: await h.row(attempt.no) }).toEqual(before);
        expect(h.wechatPay.calls).toHaveLength(calls);
      }
    },
    SLOW,
  );
});

describe("三段式：幂等为 none（验收 8）", () => {
  it(
    "走同一条“事务外调外部、事务内落结果”的路，用例前后幂等表的行数不变；失败时照样补偿",
    async () => {
      const none = () => createIdempotencyContext({ mode: "none", scope: "m.paymentOrder.sync" });
      const before = await h.prisma.idempotencyRecord.count();

      const attempt = attemptOf("none");
      const idem = none();
      const { result } = await h.send("multi_tx", attempt, idem);
      expect(idem).toMatchObject({ used: true, replayed: false });
      expect(result.outTradeNo).toBe(attempt.no);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });

      // 没有幂等记录就没有重放：再来一次照常执行（去重靠用例自己，如账本操作键）
      await h.send("multi_tx", attempt, none());
      expect(await h.row(attempt.no)).toMatchObject({ settled: 2 });
      expect(h.calls(attempt.no)).toBe(2);

      // 不给上下文也行；外呼失败照样执行补偿
      const failing = attemptOf("none-fail");
      h.wechatPay.failNext("createJsapiOrder");
      const run = h.threePhase.run(
        samplePrepay(
          "local_first",
          { wechatPay: h.wechatPay },
          { outTradeNo: failing.no, amountFen: 100, payerOpenid: "o-sample" },
        ),
      );
      await rejects(run, "PROVIDER_UNAVAILABLE");
      expect(await h.row(failing.no)).toBeUndefined();

      expect(await h.prisma.idempotencyRecord.count()).toBe(before);
    },
    SLOW,
  );
});

describe("三段式：幂等上下文只给一次", () => {
  it("同一个 required 上下文第二次交进来即抛错，不外呼", async () => {
    const attempt = attemptOf("ctx-twice");
    const { idem } = await h.send("external_first", attempt);
    const calls = h.wechatPay.calls.length;
    const again = h.send("external_first", attempt, idem);
    await expect(again).rejects.toBeInstanceOf(KernelViolation);
    await expect(again).rejects.toMatchObject({ kind: "idempotency_context_reused" });
    expect(h.wechatPay.calls).toHaveLength(calls);
  });
});
