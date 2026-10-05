import { COMMON_ERRORS } from "@liyoxi/contract/errors";
import { describe, expect, it } from "vitest";

import { CallInterruptedError } from "../../testing/index.js";
import { IDEMPOTENCY_LEASE_MS } from "../idempotency.js";
import { attemptOf, SLOW, useThreePhase } from "./__fixtures__/harness.js";

// 验收第 1 条：外呼前中断。占用已提交、外呼还没发出去，进程断了（注入的中断原样抛出，什么都不收拾）。
// 占用期内重复请求得 IDEMPOTENCY_IN_PROGRESS；拨时钟过 30 秒，重复请求抢到占用并续做；外呼一次，结果一份，幂等行 done。

const h = useThreePhase();

describe("三段式：外呼前中断", () => {
  it(
    "占用留着；占用期内重复请求 IDEMPOTENCY_IN_PROGRESS（可重试）；过期后续做，外呼一次、结果一份",
    async () => {
      const attempt = attemptOf("before");
      h.interrupter.arm("before");
      await expect(h.send("multi_tx", attempt)).rejects.toBeInstanceOf(CallInterruptedError);

      // 断在外呼之前：意图已提交，外部没收到，占用还在
      expect(h.calls(attempt.no)).toBe(0);
      expect(await h.row(attempt.no)).toMatchObject({ status: "pending", settled: 0 });
      const lease = new Date(h.clock.now().getTime() + IDEMPOTENCY_LEASE_MS);
      expect(await h.idemRow(attempt)).toMatchObject({
        state: "in_progress",
        lockedUntil: lease,
        result: null,
      });

      // 占用期内：差 1 毫秒到期也还是处理中，不外呼
      h.clock.advance(IDEMPOTENCY_LEASE_MS - 1);
      await expect(h.send("multi_tx", attempt)).rejects.toMatchObject({
        name: "AppError",
        error: "IDEMPOTENCY_IN_PROGRESS",
      });
      expect(COMMON_ERRORS.IDEMPOTENCY_IN_PROGRESS).toMatchObject({ http: 409, retryable: true });
      expect(h.calls(attempt.no)).toBe(0);
      expect(await h.idemRow(attempt)).toMatchObject({ state: "in_progress", lockedUntil: lease });

      // 到期：重复请求抢到占用，从外呼续做
      h.clock.advance(1);
      const { result, idem } = await h.send("multi_tx", attempt);
      expect(idem).toMatchObject({ used: true, replayed: false });
      expect(h.calls(attempt.no)).toBe(1);
      expect(result).toEqual({
        outTradeNo: attempt.no,
        prepayId: h.wechatPay.orders.get(attempt.no)?.prepayId,
        payParams: expect.stringContaining("prepay_id="),
      });
      expect(await h.row(attempt.no)).toEqual({
        outTradeNo: attempt.no,
        status: "prepaid",
        prepayId: result.prepayId,
        settled: 1,
      });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", lockedUntil: null, result });
    },
    SLOW,
  );

  it(
    "没有 claim 的形态（先调外部）一样：占用单独提交，过期后续做",
    async () => {
      const attempt = attemptOf("before-ef");
      h.interrupter.arm("before");
      await expect(h.send("external_first", attempt)).rejects.toBeInstanceOf(CallInterruptedError);
      expect(await h.row(attempt.no)).toBeUndefined();
      expect(await h.idemRow(attempt)).toMatchObject({ state: "in_progress" });

      h.clock.advance(IDEMPOTENCY_LEASE_MS);
      const { result } = await h.send("external_first", attempt);
      expect(h.calls(attempt.no)).toBe(1);
      expect(await h.row(attempt.no)).toMatchObject({ status: "prepaid", settled: 1 });
      expect(await h.idemRow(attempt)).toMatchObject({ state: "done", result });
    },
    SLOW,
  );
});
